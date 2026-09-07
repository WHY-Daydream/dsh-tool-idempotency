/**
 * Regression suite for the P0 store hardening (2026-09-07 audit).
 *
 * Pre-fix behavior (HEAD b6db190): `MemoryStore.put` evicted the *oldest
 * entry* — including an in-flight `executing` lock — when `maxEntries` was
 * reached, so a second key could silently drop the lock of a running
 * execution; the evicted execution later re-ran its side effect, and its
 * completion overwrote (or its failure deleted) the newer record.
 *
 * Fixed contract covered here:
 * - cache capacity pressure never evicts an in-flight lock;
 * - `maxInFlight` saturation refuses new claims instead of bypassing the guard;
 * - settlements are owner-scoped: stale owners cannot delete or overwrite;
 * - TTL governs the succeeded cache only, never an in-flight lock;
 * - `delete` invalidates the cache but never touches a live lock.
 *
 * 0.2.0 契约补充：无提交证据的错误 → unknown 墓碑（重试被阻止，release/confirm 解除）；
 * 带 NOT_COMMITTED 证据 → failed_safe（释放且不留记录，重试允许）。
 */

import { describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MemoryStore, NOT_COMMITTED_CODE } from '../src/stores/memory.js'

function okResult(n: number): ToolExecutionResult {
  return { isError: false, content: [{ type: 'text', text: `ok-${n}` }] } as unknown as ToolExecutionResult
}

function errResult(): ToolExecutionResult {
  return { isError: true, content: [{ type: 'text', text: 'boom' }] } as unknown as ToolExecutionResult
}

/** 带「确定未提交」证据的错误结果（failed_safe 路径）。 */
function notCommittedResult(): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
    error: { message: 'not committed', info: { name: 'NotCommitted', code: NOT_COMMITTED_CODE } },
  } as unknown as ToolExecutionResult
}

describe('MemoryStore P0 — in-flight locks survive cache capacity', () => {
  it('A/B/A interleave: cache pressure never evicts the executing lock, retries join', async () => {
    const store = new MemoryStore(1) // maxEntries = 1: the audit repro capacity
    const a = store.reserve('A', 'fp-a')
    expect(a).not.toBeNull()
    expect(store.get('A')?.state).toBe('executing')

    // B is a different key: it claims and completes, filling the cache to cap.
    const b = store.reserve('B', 'fp-b')
    expect(b).not.toBeNull()
    store.settle('B', b!.owner, okResult(1), 1000)
    expect(store.get('B')?.state).toBe('succeeded')
    // P0: A's lock must still be live after B's cache write.
    expect(store.get('A')?.state).toBe('executing')

    // A retry of A must join, never claim twice (forking the side effect).
    expect(() => store.reserve('A', 'fp-a')).toThrow(/duplicate in-flight/)

    // Completing A caches it; the oldest cache row (B) is evicted instead.
    const aResult = okResult(2)
    store.settle('A', a!.owner, aResult, 1000)
    await expect(a!.promise).resolves.toBe(aResult)
    expect(store.get('A')?.state).toBe('succeeded')
    expect(store.get('A')?.result).toBe(aResult)
    expect(store.get('B')).toBeUndefined()
  })

  it('does not evict a live lock even when every cache slot is hot', async () => {
    const store = new MemoryStore(2)
    const hold = store.reserve('LOCKED', 'fp-x')
    expect(hold).not.toBeNull()
    const c1 = store.reserve('c1', 'fp-1')!
    store.settle('c1', c1.owner, okResult(1), 1000)
    const c2 = store.reserve('c2', 'fp-2')!
    store.settle('c2', c2.owner, okResult(2), 1000)
    const c3 = store.reserve('c3', 'fp-3')!
    store.settle('c3', c3.owner, okResult(3), 1000) // cache over cap → evicts c1
    expect(store.get('c1')).toBeUndefined()
    expect(store.get('c2')?.state).toBe('succeeded')
    expect(store.get('c3')?.state).toBe('succeeded')
    expect(store.get('LOCKED')?.state).toBe('executing')
  })
})

describe('MemoryStore P0 — in-flight capacity is refused, never bypassed', () => {
  it('saturating maxInFlight refuses the claim without disturbing live locks', () => {
    const store = new MemoryStore(5, 2)
    const x = store.reserve('X', 'fp-x')
    const y = store.reserve('Y', 'fp-y')
    expect(x).not.toBeNull()
    expect(y).not.toBeNull()
    expect(store.reserve('Z', 'fp-z')).toBeNull() // refused — no lock eviction, no unprotected run
    expect(store.get('X')?.state).toBe('executing')
    expect(store.get('Y')?.state).toBe('executing')
    expect(store.size).toBe(2)

    // Freeing a slot lets Z claim.
    store.settle('X', x!.owner, okResult(1), 1000)
    const z = store.reserve('Z', 'fp-z')
    expect(z).not.toBeNull()
    store.settle('Y', y!.owner, okResult(2), 1000)
    store.settle('Z', z!.owner, okResult(3), 1000)
    expect(store.size).toBe(3)
  })

  it('a same-key retry is never refused by capacity — it stays joinable while the table is full', async () => {
    const store = new MemoryStore(2, 1)
    const k = store.reserve('K', 'fp-k')
    expect(k).not.toBeNull()
    expect(store.reserve('other', 'fp-o')).toBeNull() // new key refused at maxInFlight=1
    expect(store.get('K')?.state).toBe('executing') // K untouched and joinable

    const done = okResult(7)
    store.settle('K', k!.owner, done, 1000)
    await expect(k!.promise).resolves.toBe(done) // the join contract settles with the owner's result
  })

  it('a failed placeholder frees the in-flight slot immediately — no zombie claim', () => {
    const store = new MemoryStore(5, 1)
    const r = store.reserve('K', 'fp-k')
    expect(r).not.toBeNull()
    r!.promise.catch(() => undefined)
    store.fail('K', r!.owner, new Error('downstream-boom')) // synchronous downstream failure path

    // The same key is immediately retryable (no zombie claim).
    const again = store.reserve('K', 'fp-k')
    expect(again).not.toBeNull()
    // Settle it, then a different key can claim the freed slot as well.
    store.settle('K', again!.owner, okResult(1), 1000)
    expect(store.reserve('other', 'fp-o')).not.toBeNull()
    expect(store.size).toBe(2) // K cached (1) + other executing (1)
  })
})

describe('MemoryStore P0 — owner-scoped settlements', () => {
  it('a stale owner can neither delete a newer lock nor overwrite it with a cached row', async () => {
    const store = new MemoryStore(5, 5)
    const first = store.reserve('K', 'fp-k')
    expect(first).not.toBeNull()
    first!.promise.catch(() => undefined) // the first owner is failed below
    store.fail('K', first!.owner, new Error('boom-1'))
    expect(store.get('K')?.state).toBe('unknown') // 0.2.0：无提交证据的失败 → unknown（重试被阻止）
    store.release('K') // 对账解除 → 可重新执行
    expect(store.get('K')).toBeUndefined()

    const second = store.reserve('K', 'fp-k')
    expect(second).not.toBeNull()

    // Stale failure from the first owner must not delete the new lock.
    store.fail('K', first!.owner, new Error('stale'))
    expect(store.get('K')?.owner).toBe(second!.owner)
    expect(store.get('K')?.state).toBe('executing')

    // Stale success must not overwrite the new lock or write a cache row.
    store.settle('K', first!.owner, okResult(99), 1000)
    expect(store.get('K')?.owner).toBe(second!.owner)
    expect(store.get('K')?.state).toBe('executing')

    // The real owner completes normally.
    const done = okResult(2)
    store.settle('K', second!.owner, done, 1000)
    await expect(second!.promise).resolves.toBe(done)
    expect(store.get('K')?.state).toBe('succeeded')
    expect(store.get('K')?.result).toBe(done)

    // Even after a succeeded cache row exists, a late stale success changes nothing.
    store.settle('K', first!.owner, okResult(99), 1000)
    expect(store.get('K')?.result).toBe(done)
  })

  it('error results: NOT_COMMITTED evidence releases without a record; plain errors → unknown tombstone', () => {
    const store = new MemoryStore(5, 5)

    // failed_safe：带 NOT_COMMITTED 证据 → 释放且不留记录，重试允许重新执行
    const r1 = store.reserve('K1', 'fp-1')
    expect(r1).not.toBeNull()
    store.settle('K1', r1!.owner, notCommittedResult(), 1000)
    expect(store.get('K1')).toBeUndefined()
    const again1 = store.reserve('K1', 'fp-1')
    expect(again1).not.toBeNull()
    store.settle('K1', again1!.owner, okResult(1), 1000)
    expect(store.get('K1')?.state).toBe('succeeded')

    // 无提交证据的错误 → unknown 墓碑（重试被阻止；release/confirm 解除）
    const r2 = store.reserve('K2', 'fp-2')
    expect(r2).not.toBeNull()
    store.settle('K2', r2!.owner, errResult(), 1000)
    expect(store.get('K2')?.state).toBe('unknown')
    expect(store.get('K2')?.fingerprint).toBe('fp-2')
    store.release('K2')
    expect(store.get('K2')).toBeUndefined()
  })
})

describe('MemoryStore P0 — TTL and delete boundaries', () => {
  it('TTL governs the succeeded cache only, never an in-flight lock', () => {
    let now = 1000
    const store = new MemoryStore(10, 10, 10, () => now)
    const r = store.reserve('K', 'fp-k')
    expect(r).not.toBeNull()
    now = 2 ** 40 // arbitrarily far future
    expect(store.get('K')?.state).toBe('executing') // an in-flight task is not re-entered by TTL

    store.settle('K', r!.owner, okResult(1), 100) // cache expires at now + 100
    expect(store.get('K')?.state).toBe('succeeded')
    now += 101
    expect(store.get('K')).toBeUndefined() // TTL expired → miss → retry allowed
  })

  it('delete() invalidates the cache but never a live lock', () => {
    const store = new MemoryStore(5, 5)
    const r = store.reserve('K', 'fp-k')
    expect(r).not.toBeNull()
    store.delete('K')
    expect(store.get('K')?.state).toBe('executing') // lock untouched

    store.settle('K', r!.owner, okResult(1), 1000)
    expect(store.get('K')?.state).toBe('succeeded')
    store.delete('K') // inFlightOnly-style cache invalidation
    expect(store.get('K')).toBeUndefined()
    expect(store.size).toBe(0)
  })
})

describe('MemoryStore constructor validation', () => {
  it('rejects a non-positive maxEntries', () => {
    expect(() => new MemoryStore(0)).toThrow(/maxEntries/)
  })

  it('rejects a non-positive maxInFlight', () => {
    expect(() => new MemoryStore(1, 0)).toThrow(/maxInFlight/)
  })
})

describe('MemoryStore 0.2.0 — unknown 墓碑与 failed_safe 证据（store 层契约）', () => {
  it('fail() 抛错携带 NOT_COMMITTED 证据 → failed_safe：不留墓碑，重试可重新执行', () => {
    const store = new MemoryStore(2)
    const r = store.reserve('K', 'fp-k')
    expect(r).not.toBeNull()
    store.fail('K', r!.owner, { info: { name: 'NotCommitted', code: NOT_COMMITTED_CODE } })
    expect(store.get('K')).toBeUndefined() // 无墓碑
    expect(store.size).toBe(0)
  })

  it('fail() 无证据抛错 → unknown 墓碑：重试 blocked，容量压力不淘汰墓碑', () => {
    const store = new MemoryStore(2) // maxEntries=2：墓碑豁免容量淘汰
    for (let i = 0; i < 5; i++) {
      const r = store.reserve(`K${i}`, `fp-${i}`)
      store.fail(`K${i}`, r!.owner, new Error('boom'))
    }
    for (let i = 0; i < 5; i++) {
      expect(store.get(`K${i}`)?.state).toBe('unknown')
    }
    expect(store.size).toBe(5) // 5 个墓碑全部保留（超过 maxEntries 也不淘汰）

    store.release('K0')
    expect(store.get('K0')).toBeUndefined() // 显式 release 是唯一解除路径
    expect(store.get('K1')?.state).toBe('unknown') // 其余仍 blocked
    expect(store.size).toBe(4)
  })

  it('release() 递增代次：陈旧 owner fail 不写回 unknown', () => {
    const store = new MemoryStore(4)
    const r = store.reserve('K', 'fp-k')
    expect(r).not.toBeNull()
    store.release('K') // 代次 → 2
    store.fail('K', r!.owner, new Error('late boom'))
    expect(store.get('K')).toBeUndefined() // 无墓碑写回
    expect(store.size).toBe(0)
  })

  it('墓碑预算：满时 reserve 前置拒绝（不淘汰旧墓碑），release 对账后恢复', () => {
    const store = new MemoryStore(4, 4, 2) // maxUnknown = 2
    const a = store.reserve('A', 'fp-a')
    store.fail('A', a!.owner, new Error('x'))
    const b = store.reserve('B', 'fp-b')
    store.fail('B', b!.owner, new Error('x'))
    expect(store.get('A')?.state).toBe('unknown')
    expect(store.get('B')?.state).toBe('unknown')
    expect(store.unknownFull).toBe(true)

    // 满时新 key 前置拒绝：不执行、不淘汰旧墓碑
    expect(store.reserve('C', 'fp-c')).toBeNull()
    expect(store.get('A')?.state).toBe('unknown') // 历史 unknown 不被绕过
    expect(store.get('B')?.state).toBe('unknown')
    expect(store.size).toBe(2)

    // 对账 release 一个 → 恢复可执行；再失败仍有位置记录 unknown
    store.release('A')
    expect(store.unknownFull).toBe(false)
    const c = store.reserve('C', 'fp-c')
    expect(c).not.toBeNull()
    store.fail('C', c!.owner, new Error('x'))
    expect(store.get('C')?.state).toBe('unknown')
    expect(store.get('B')?.state).toBe('unknown') // 历史墓碑仍在
    expect(store.size).toBe(2)

    // confirm 同样释放预算
    store.confirm('C', 'fp-c', okResult(1), 1000)
    expect(store.get('C')?.state).toBe('succeeded')
    const d = store.reserve('D', 'fp-d')
    expect(d).not.toBeNull()
    store.settle('D', d!.owner, okResult(1), 1000)
    expect(store.size).toBe(3) // B(unknown) + C(succeeded) + D(succeeded)
  })

  it('rejects a non-positive maxUnknown', () => {
    expect(() => new MemoryStore(1, 1, 0)).toThrow(/maxUnknown/)
  })
})
