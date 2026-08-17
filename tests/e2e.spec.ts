/**
 * End-to-end composition suite for the DSH Reliability Suite (no network).
 *
 * Scenario A: a real agent loop retries a timed-out `create_order` — the
 * idempotency guard makes the retry safe (a single real side effect) and
 * reuses the recorded result for a further duplicate.
 *
 * Scenario B: a composite `process_order` tool runs a Saga (create_order →
 * reserve_inventory → charge_payment) through the tool pipeline; chaos faults
 * charge_payment, the guard dedups the duplicate create_order dispatch, and
 * the transaction compensates in reverse order (release_inventory →
 * cancel_order) ending ROLLED_BACK.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Chaos from '@why-daydream/dsh-chaos'
import * as Transaction from '@why-daydream/dsh-tool-transaction'
import * as Idempotency from '../src/index.js'
import { MockAdapter, textResponse, toolCallResponse } from '../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'

/**
 * Boot the core spine + chaos + idempotency, in that order — chaos registers
 * its `tools/execute` listener first and therefore wraps the chain outermost,
 * so a fault short-circuits before the guard ever sees the call.
 */
async function harness(
  chaos: Chaos.Config,
  idempotency: Idempotency.Config = {},
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Chaos, chaos)
  await ctx.plugin(Idempotency, idempotency)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: s, status }) => {
      if (s === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Inner content blocks of a session `tool-result` message wrapper block. */
function innerContent(block: { type: string; content?: unknown } | undefined): unknown {
  return block?.type === 'tool-result' ? block.content : undefined
}

/** Every materialized tool result in the agent's session log. */
function toolResults(agent: Agent): SessionEvent<'tool/result'>[] {
  return [...agent.session.events].filter(
    (event): event is SessionEvent<'tool/result'> => event.type === 'tool/result',
  )
}

describe('E2E scenario A: chaos timeout → agent retry → idempotency reuse', () => {
  it('executes the real side effect exactly once across three identical calls', async () => {
    const ctx = await harness(
      // Seed 9: chaos roll sequence (including the `tools/post-execute`
      // failureRate roll consumed for every call) is [timeout, pass, pass]
      // so the FIRST create_order call times out and both retries pass through.
      { seed: 9, rules: [{ tool: 'create_order', failureRate: 0.5, timeout: { afterMs: 30, probability: 1 } }] },
      { rules: [{ tool: 'create_order', keyArg: 'requestId' }] },
    )

    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create an order',
      parameters: {},
      async execute(args) {
        executions += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `order ${orderId} created (#${executions})` }]
      },
    }))

    // The scripted model retries the exact same call twice after the timeout,
    // then a third identical call — the guard must deduplicate.
    const adapter = new MockAdapter([
      toolCallResponse('c0', 'create_order', { orderId: 'o1', requestId: 'r1' }),
      toolCallResponse('c1', 'create_order', { orderId: 'o1', requestId: 'r1' }),
      toolCallResponse('c2', 'create_order', { orderId: 'o1', requestId: 'r1' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // One real execution — the timeout never ran the tool and the retries reused.
    expect(executions).toBe(1)

    const results = toolResults(agent)
    expect(results).toHaveLength(3)
    // First call: chaos injected TOOL_TIMEOUT.
    expect(results[0]!.data.error?.code).toBe('TOOL_TIMEOUT')
    // Retry + duplicate: identical success results — the retry reused the first.
    expect(results[1]!.data.error).toBeUndefined()
    expect(results[2]!.data.error).toBeUndefined()
    // message.content is a `tool-result` wrapper block carrying the real
    // blocks; the wrapper's toolCallId differs per call, so compare the inner
    // content — the retry reused the first call's result verbatim.
    expect(innerContent(results[1]!.data.message.content[0]))
      .toEqual(innerContent(results[2]!.data.message.content[0]))
    expect(results[1]!.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: 'order o1 created (#1)' }],
    })
  })
})

describe('E2E scenario B: transaction compensation as the backstop', () => {
  it('rolls back in reverse order when chaos keeps failing charge_payment', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Chaos, { rules: [{ tool: 'charge_payment', error: { status: 500, probability: 1 } }] })
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    await ctx.plugin(Transaction, {})

    const effects = {
      createOrder: 0,
      reserveInventory: 0,
      chargePayment: 0,
      cancelOrder: 0,
      releaseInventory: 0,
    }

    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create an order',
      parameters: {},
      async execute(args) {
        effects.createOrder += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `order ${orderId} created` }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'reserve_inventory',
      description: 'reserve stock',
      parameters: {},
      async execute(args) {
        effects.reserveInventory += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `inventory reserved for ${orderId}` }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'charge_payment',
      description: 'charge the payment',
      parameters: {},
      async execute(args) {
        effects.chargePayment += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `payment charged for ${orderId}` }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'cancel_order',
      description: 'cancel an order',
      parameters: {},
      async execute(args) {
        effects.cancelOrder += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `order ${orderId} cancelled` }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'release_inventory',
      description: 'release reserved stock',
      parameters: {},
      async execute(args) {
        effects.releaseInventory += 1
        const { orderId } = args as { orderId: string }
        return [{ type: 'text', text: `inventory released for ${orderId}` }]
      },
    }))

    // Composite Saga tool: every step dispatches through the real tool
    // pipeline so chaos + idempotency wrap each nested call. The create_order
    // step dispatches the same logical call twice — the guard must reuse the
    // recorded result instead of executing the side effect again.
    const rollbacks: string[] = []
    ctx.on('transaction/rollback-end', (data) => {
      if (data.state !== undefined) rollbacks.push(data.state)
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'process_order',
      description: 'process an order end to end',
      parameters: {},
      async execute() {
        const tx = ctx.transaction.begin()
        const signal = new AbortController().signal // nested dispatches require a caller-owned signal
        try {
          await tx.step({
            name: 'create_order',
            execute: async () => {
              const first = await ctx.tools.execute({
                callId: CallId('create-1'),
                name: 'create_order',
                arguments: { orderId: 'o1', requestId: 'r1' },
                signal,
              })
              const duplicate = await ctx.tools.execute({
                callId: CallId('create-2'),
                name: 'create_order',
                arguments: { orderId: 'o1', requestId: 'r1' },
                signal,
              })
              if (first.isError || duplicate.isError) throw new Error('create_order failed')
              return first.content
            },
            compensate: async () => {
              await ctx.tools.execute({ callId: CallId('cancel-1'), name: 'cancel_order', arguments: { orderId: 'o1' }, signal })
            },
          })
          await tx.step({
            name: 'reserve_inventory',
            execute: async () => {
              const result = await ctx.tools.execute({
                callId: CallId('reserve-1'),
                name: 'reserve_inventory',
                arguments: { orderId: 'o1' },
                signal,
              })
              if (result.isError) throw new Error('reserve_inventory failed')
              return result.content
            },
            compensate: async () => {
              await ctx.tools.execute({ callId: CallId('release-1'), name: 'release_inventory', arguments: { orderId: 'o1' }, signal })
            },
          })
          await tx.step({
            name: 'charge_payment',
            execute: async () => {
              const result = await ctx.tools.execute({
                callId: CallId('charge-1'),
                name: 'charge_payment',
                arguments: { orderId: 'o1', amount: 100, requestId: 'r1' },
                signal,
              })
              if (result.isError) throw new Error('charge_payment failed')
              return result.content
            },
          })
          await tx.commit()
          return [{ type: 'text', text: 'order committed' }]
        } catch (error) {
          await tx.rollback()
          throw new Error(`order rolled back: ${(error as Error).message}`)
        }
      },
    }))

    const adapter = new MockAdapter([
      toolCallResponse('p0', 'process_order', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('b1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The duplicate create_order dispatch was deduplicated: exactly one order.
    expect(effects.createOrder).toBe(1)
    // Forward steps ran once each (charge_payment never ran — chaos short-circuited).
    expect(effects.reserveInventory).toBe(1)
    expect(effects.chargePayment).toBe(0)
    // Reverse-order compensation ran exactly once per committed step.
    expect(effects.cancelOrder).toBe(1)
    expect(effects.releaseInventory).toBe(1)
    // The saga settled ROLLED_BACK.
    expect(rollbacks).toEqual(['ROLLED_BACK'])

    // The model saw the failure (the composite tool surfaced the rollback).
    // Scenario B makes exactly one model-visible tool call — process_order —
    // and CallId is a branded object, so compare positionally, not by identity.
    // A thrown plain Error materializes without `error.info`, so the error is
    // asserted through the `tool-result` wrapper block instead of `data.error`.
    const results = toolResults(agent)
    expect(results).toHaveLength(1)
    expect(results[0]!.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('rolled back') }],
    })
  })
})
