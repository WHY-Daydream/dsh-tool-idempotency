/**
 * Behavior suite for the dsh-tool-idempotency guard: opt-in gating, cached
 * result reuse, in-flight joining, same-key/different-args fail-loud, retry
 * re-execution after failure, TTL expiry, irreversible (inFlightOnly) tools,
 * and fail-loud config validation — driven through the real tool registry
 * (no network).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '../src/index.js'
import type { Config } from '../src/index.js'

const testToolSignal = new AbortController().signal

let callSequence = 0
function nextCallId(): string {
  callSequence += 1
  return `c${callSequence}`
}

/**
 * dsh-llm renamed its call-id brand `CallId` → `ToolCallId` between the
 * 0.1.0-rc.5 baseline link and 0.1.2-rc.1+ (PCA F2b'); resolve whichever the
 * linked package exports so this suite runs against both eras (test-only).
 */
async function brandCallId(id: string): Promise<never> {
  const llm = (await import('@deepseek-ai/dsh-llm')) as Record<string, unknown>
  const make = (llm.ToolCallId ?? llm.CallId) as ((s: string) => unknown) | undefined
  if (typeof make !== 'function') throw new Error('dsh-llm exports neither ToolCallId nor CallId')
  return make(id) as never
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
async function executeTool(ctx: Context, name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
  return ctx.tools.execute({
    callId: await brandCallId(nextCallId()),
    name,
    // JsonValue is re-exported from dsh-tools' main entry only in the 0.1.0-rc.5-era
    // baseline, not in 0.1.2-rc.1+ (PCA F2c) — the erased `never` cast keeps this
    // suite compiling against both; the runtime value is unaffected.
    arguments: argumentsValue as unknown as never,
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

  it('rejects a non-positive maxInFlight', async () => {
    await expect(failingHarness({ maxInFlight: 0 })).rejects.toThrow(/maxInFlight/)
  })

  it('rejects a rule without a tool pattern', async () => {
    await expect(failingHarness({ rules: [{ mode: 'reuse' }] } as Config)).rejects.toThrow(/tool/)
  })
})

describe('P0 regression — cache capacity never evicts an in-flight lock (A/B/A, maxEntries=1)', () => {
  it('a retry of an executing key joins instead of re-executing, even under cache pressure', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxEntries: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) return gate.promise // A: held in flight
      return [{ type: 'text', text: `order-${attempts}` }] // B and later calls run immediately
    })

    const a1 = executeTool(ctx, 'create_order', { orderId: 'a' }) // A claims the lock (attempt 1)
    // B is a different key: it claims and completes, filling the cache to cap.
    // Pre-fix, B's cache write evicted A's executing lock here.
    const b1 = await executeTool(ctx, 'create_order', { orderId: 'b' })
    expect(b1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })

    const a2 = executeTool(ctx, 'create_order', { orderId: 'a' }) // must JOIN A, not re-execute
    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [ra1, ra2] = await Promise.all([a1, a2])
    expect(attempts).toBe(2) // A ran once, B ran once — A's retry was deduplicated
    expect(ra1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(ra2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})

describe('P0 regression — in-flight capacity is refused, never bypassed', () => {
  it('returns a structured capacity error and does not run the side effect', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const first = executeTool(ctx, 'create_order', { orderId: 'a' }) // occupies the only slot
    const refused = await executeTool(ctx, 'create_order', { orderId: 'b' })
    expect(refused).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_CAPACITY_REJECTED', name: 'IdempotencyCapacityRejected' } },
    })
    expect(attempts).toBe(1) // the refused call never reached the tool

    gate.resolve([{ type: 'text', text: 'order-1' }])
    await first
    const after = await executeTool(ctx, 'create_order', { orderId: 'b' }) // slot free again
    expect(after).toMatchObject({ isError: false })
    expect(attempts).toBe(2)
  })

  it('joins a same-key retry while the in-flight table is full — only new keys are refused', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const a1 = executeTool(ctx, 'create_order', { orderId: 'a' }) // claims the only slot
    const a2 = executeTool(ctx, 'create_order', { orderId: 'a' }) // same-key retry → join, never refuse
    const refused = await executeTool(ctx, 'create_order', { orderId: 'b' }) // new key → capacity error
    expect(refused).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_CAPACITY_REJECTED' } },
    })
    expect(attempts).toBe(1) // the join and the refusal left the side effect at exactly one run

    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [ra1, ra2] = await Promise.all([a1, a2])
    expect(attempts).toBe(1)
    expect(ra1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(ra2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })

    const after = await executeTool(ctx, 'create_order', { orderId: 'b' }) // slot free → executes
    expect(after).toMatchObject({ isError: false })
    expect(attempts).toBe(2)
  })

  it('a synchronous downstream throw releases the owner — retry re-executes, no zombie lock', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    // Registered after the plugin loaded, this wrapper sits downstream of the
    // idempotency guard and throws synchronously inside the guard's `next()` —
    // the placeholder must have been claimed and must be released by the catch.
    const removeThrower = ctx.on('tools/execute', () => {
      throw new Error('sync-downstream-boom')
    }) as unknown as () => void

    const first = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(first).toMatchObject({ isError: true }) // the dispatcher converts the throw to a tool error result
    expect(attempts).toBe(0) // the tool body was never reached

    removeThrower()
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1) // the failed claim released the lock; the retry executed exactly once
  })
})

describe('P0 regression — own __proto__ argument fields are distinct requests', () => {
  it('does not merge a request carrying an own __proto__ field into a plain one', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    // Legal JSON: JSON.parse creates `__proto__` as an own data property.
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>
    const without = JSON.parse('{"a":1}') as Record<string, unknown>

    const r1 = await executeTool(ctx, 'create_order', withProto)
    const r2 = await executeTool(ctx, 'create_order', without)
    // Pre-fix the canonicalizer dropped the own field and r2 replayed r1 (attempts stayed 1).
    expect(attempts).toBe(2)
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })

    // Identical requests still deduplicate, including the special key.
    const r3 = await executeTool(ctx, 'create_order', withProto)
    expect(attempts).toBe(2)
    expect(r3).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})
