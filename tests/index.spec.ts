/**
 * Behavior suite for the dsh-tool-idempotency guard: opt-in gating, cached
 * result reuse, in-flight joining, same-key/different-args fail-loud, retry
 * re-execution after failure, TTL expiry, irreversible (inFlightOnly) tools,
 * and fail-loud config validation — driven through the real tool registry
 * (no network).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type JsonValue } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '../src/index.js'
import type { Config } from '../src/index.js'

const testToolSignal = new AbortController().signal

let callSequence = 0
function nextCallId(): string {
  callSequence += 1
  return `c${callSequence}`
}

/** Boot the system-prompt + tool registry + the idempotency plugin. */
async function toolHarness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Idempotency, config)
  return ctx
}

/** Register a side-effect tool whose body runs exactly once per real call. */
function registerTool(ctx: Context, name: string, body: () => ContentBlock[] | Promise<ContentBlock[]>): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      return await body()
    },
  }))
}

/** Dispatch one tool call through the real pipeline. */
function executeTool(ctx: Context, name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
  return ctx.tools.execute({
    callId: CallId(nextCallId()),
    name,
    arguments: argumentsValue as unknown as JsonValue,
    signal: testToolSignal,
  })
}

/** A manually-resolvable promise for controlling in-flight timing. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('opt-in gating', () => {
  it('passes through tools without a matching rule', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'other', async () => {
      attempts += 1
      return [{ type: 'text', text: 'ok' }]
    })
    await executeTool(ctx, 'other', {})
    await executeTool(ctx, 'other', {})
    expect(attempts).toBe(2)
  })

  it('mode off disables the guard for matched tools', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', mode: 'off' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'ok' }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(2)
  })
})

describe('cached result reuse (request fingerprint key)', () => {
  it('replays the cached result for an identical retry', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const first = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1)
    expect(first).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })

  it('argument property order does not change the fingerprint', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { a: 1, b: 2 })
    const second = await executeTool(ctx, 'create_order', { b: 2, a: 1 })
    expect(attempts).toBe(1)
    expect(second).toMatchObject({ isError: false })
  })
})

describe('explicit idempotency key (keyArg)', () => {
  it('reuses across identical calls carrying the same explicit key', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    expect(attempts).toBe(1)
  })

  it('fails loud when the same key carries different arguments', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    const conflict = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'b' })
    expect(attempts).toBe(1)
    expect(conflict).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_KEY_MISMATCH', name: 'IdempotencyKeyMismatch' } },
    })
  })

  it('falls back to the request fingerprint when the key argument is absent', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1)
  })
})

describe('concurrency (in-flight lock)', () => {
  it('joins a concurrent duplicate instead of re-executing', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const first = executeTool(ctx, 'create_order', { orderId: 'a' })
    const second = executeTool(ctx, 'create_order', { orderId: 'a' })
    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [r1, r2] = await Promise.all([first, second])
    expect(attempts).toBe(1)
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })

  it('fails loud when a concurrent call reuses the key with different args', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const first = executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    const second = executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'b' })
    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [r1, r2] = await Promise.all([first, second])
    expect(attempts).toBe(1)
    expect(r1).toMatchObject({ isError: false })
    expect(r2).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_KEY_MISMATCH' } },
    })
  })
})

describe('failure handling', () => {
  it('re-executes after the first attempt fails', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: 'order-ok' }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(2)
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-ok' }] })
  })
})

describe('TTL expiry', () => {
  it('re-executes once the cached result has expired', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(2)
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
  })
})

describe('irreversible tools (inFlightOnly)', () => {
  it('never replays a cached result — retries re-execute', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
    registerTool(ctx, 'send_email', async () => {
      attempts += 1
      return [{ type: 'text', text: `sent-${attempts}` }]
    })
    await executeTool(ctx, 'send_email', { to: 'a@x' })
    const second = await executeTool(ctx, 'send_email', { to: 'a@x' })
    expect(attempts).toBe(2)
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'sent-2' }] })
  })

  it('still joins concurrent duplicates', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
    registerTool(ctx, 'send_email', async () => {
      attempts += 1
      return gate.promise
    })
    const first = executeTool(ctx, 'send_email', { to: 'a@x' })
    const second = executeTool(ctx, 'send_email', { to: 'a@x' })
    gate.resolve([{ type: 'text', text: 'sent-1' }])
    await Promise.all([first, second])
    expect(attempts).toBe(1)
  })
})

describe('fail-loud config validation', () => {
  async function failingHarness(config: Config): Promise<unknown> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    return ctx.plugin(Idempotency, config)
  }

  it('rejects a non-positive ttl', async () => {
    await expect(failingHarness({ ttl: 0 })).rejects.toThrow(/ttl/)
  })

  it('rejects a non-positive maxEntries', async () => {
    await expect(failingHarness({ maxEntries: 0 })).rejects.toThrow(/maxEntries/)
  })

  it('rejects a rule without a tool pattern', async () => {
    await expect(failingHarness({ rules: [{ mode: 'reuse' }] } as Config)).rejects.toThrow(/tool/)
  })
})
