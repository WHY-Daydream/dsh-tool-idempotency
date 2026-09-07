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
import type { Config, ToolIdempotencyApi } from '../src/index.js'

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
async function executeTool(
  ctx: Context,
  name: string,
  argumentsValue: Record<string, unknown>,
  signal: AbortSignal = testToolSignal,
): Promise<unknown> {
  return ctx.tools.execute({
    callId: await brandCallId(nextCallId()),
    name,
    // JsonValue is re-exported from dsh-tools' main entry only in the 0.1.0-rc.5-era
    // baseline, not in 0.1.2-rc.1+ (PCA F2c) — the erased `never` cast keeps this
    // suite compiling against both; the runtime value is unaffected.
    arguments: argumentsValue as unknown as never,
    signal,
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

/** Poll until `predicate` holds (deterministic readiness barrier for cancel tests). */
async function until(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(...) timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
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

describe('failure handling (0.2.0: unknown blocks blind retry)', () => {
  it('无提交证据的失败进入 unknown：重试被阻止（STATE_UNKNOWN）；release 对账后重新执行', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: 'order-ok' }]
    })
    const first = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(first).toMatchObject({ isError: true }) // 抛错（无提交证据）

    // 0.2.0：unknown → 阻止自动重执行（K1 修复：不再盲目重试）
    const retry = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)

    // 下游对账解除后重新执行
    const api = ctx.get('toolIdempotency') as ToolIdempotencyApi
    api.release('create_order', { orderId: 'a' })
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-ok' }] })
    expect(attempts).toBe(2)
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

  it('a synchronous downstream throw releases the owner — state becomes unknown; release clears it, no zombie lock', async () => {
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
    // 0.2.0：同步抛错（无提交证据）→ unknown，重试被阻止（不盲目重执行）
    const blocked = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(blocked).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(0)

    // 对账解除后：失败的 claim 已释放锁，重试恰好执行一次
    const api = ctx.get('toolIdempotency') as ToolIdempotencyApi
    api.release('create_order', { orderId: 'a' })
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

describe('P0 regression — an aborted waiter leaves the join promptly', () => {
  it('aborting the waiter while the owner runs does not cancel the owner or fork the side effect', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const ownerCtrl = new AbortController()
    const waiterCtrl = new AbortController()
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' }, ownerCtrl.signal)
    await until(() => attempts === 1) // owner 已启动并持有执行锁
    const waiter = executeTool(ctx, 'create_order', { orderId: 'a' }, waiterCtrl.signal) // join
    await until(() => waiterCtrl.signal.aborted === false) // 仅确保信号未预取消
    await new Promise((resolve) => setTimeout(resolve, 10)) // 让 waiter 的 dispatch 进入 guard join 分支
    waiterCtrl.abort()

    // waiter 必须独立退出（owner 仍未完成）：加入超时护栏，防止回归为永久挂起
    const outcome = await Promise.race([
      waiter.then(
        (value) => ({ kind: 'resolve' as const, isError: (value as { isError?: boolean })?.isError ?? false }),
        () => ({ kind: 'reject' as const, isError: false }),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter did not leave within 300ms')), 300)),
    ])
    expect(attempts).toBe(1) // waiter 离开不影响 owner；无重复执行

    gate.resolve([{ type: 'text', text: 'order-1' }])
    const ownerResult = await owner
    expect(ownerResult).toMatchObject({ isError: false })
    expect(attempts).toBe(1)

    // owner 完成后，同 key 调用正常重放（无僵尸锁、无串用）
    const replay = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(replay).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(['resolve', 'reject']).toContain(outcome.kind) // 本地宿主可能把早期退出映射为 isError 或传播 rejection
  })
})
