/**
 * 2026-09-07 实际代码审查反例回归（3 个 P1，0.2.0 暂缓发布依据）。
 *
 * 复现阶段：这些用例在修复提交前应 FAIL（作为反例证据）；修复提交后应全部 PASS。
 * **不允许用旧套件全绿替代本文件**——旧全绿只覆盖旧路径，不覆盖这些反例。
 *
 * - P1-1 执行中 invalidate 不得丢失未知提交状态（旧失败必须保留 unknown 阻止重试）
 * - P1-2 generations 清理必须覆盖所有退出路径（循环 1000 次不得增长）
 * - P1-3 对账 API（release/confirm/invalidate）必须校验 fingerprint，冲突拒绝且保持原状态
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from '../../src/stores/memory.js'
import {
  deferred,
  executeTool,
  idempotencyApi,
  registerTool,
  toolHarness,
  until,
} from './harness.js'

function okResult(id: number): ToolExecutionResult {
  return {
    isError: false,
    content: [{ type: 'text', text: `ok-${id}` }],
    value: [{ type: 'text', text: `ok-${id}` }],
  }
}

describe('P1-1 执行中 invalidate 不得丢失未知提交状态', () => {
  it('反例：提交副作用 → 执行中 invalidate → 响应丢失（失败无证据）→ 必须写 unknown 阻止重试', async () => {
    let attempts = 0
    const gate = deferred<unknown>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      await gate.promise
      throw new Error('response lost after commit')
    })
    const p = executeTool(ctx, 'create_order', { orderId: 'k1' })
    await until(() => attempts === 1) // 副作用已提交，owner 在途
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k1' }) // 补偿流程：执行中失效
    gate.reject(new Error('response lost after commit'))
    await p
    // 修复后：unknown 必须保留（无法确定是否提交），重试被阻止
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1' })?.state).toBe('unknown')
    const retry = await executeTool(ctx, 'create_order', { orderId: 'k1' })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1) // 副作用未重复
  })

  it('invalidate 态下旧执行成功结果不写回（已失效结果不可重放）', async () => {
    let attempts = 0
    const gate = deferred<unknown>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      await gate.promise
      return [{ type: 'text', text: 'committed' }]
    })
    const p = executeTool(ctx, 'create_order', { orderId: 'k2' })
    await until(() => attempts === 1)
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k2' })
    gate.resolve(undefined)
    await p
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k2' })).toBeUndefined() // 成功不写回
  })

  it('release 态（真解除）后旧执行晚到失败：不重新上锁（解除语义保留）', async () => {
    let attempts = 0
    const gate = deferred<unknown>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      await gate.promise
      throw new Error('late failure')
    })
    const p = executeTool(ctx, 'create_order', { orderId: 'k3' })
    await until(() => attempts === 1)
    idempotencyApi(ctx).release('create_order', { orderId: 'k3' }) // 对账确认未提交后解除
    gate.reject(new Error('late failure'))
    await p
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3' })).toBeUndefined() // 不重新上锁
  })
})

describe('P1-2 generations 清理覆盖所有退出路径', () => {
  it('循环 1000 次 reserve→invalidate→settle（成功）：generations 必须清零（当前 FAIL：1000 条）', () => {
    const store = new MemoryStore(100, 100, 2000)
    const gens = (store as unknown as { generations: Map<string, number> }).generations
    for (let i = 0; i < 1000; i++) {
      const key = `k-${i}`
      const r = store.reserve(key, `fp-${i}`)
      expect(r).not.toBeNull()
      store.invalidate(key) // 执行中失效：代次 bump，不立即删
      store.settle(key, r!.owner, okResult(i), 1000) // 代次不匹配退出路径
    }
    expect(gens.size).toBe(0)
  })

  it('循环 1000 次 reserve→invalidate→fail（无证据）：写 unknown 且 generations 清零', () => {
    const store = new MemoryStore(100, 100, 2000)
    const gens = (store as unknown as { generations: Map<string, number> }).generations
    for (let i = 0; i < 1000; i++) {
      const key = `u-${i}`
      const r = store.reserve(key, `fp-${i}`)
      expect(r).not.toBeNull()
      store.invalidate(key)
      store.fail(key, r!.owner, new Error('boom'))
      expect(store.get(key)?.state).toBe('unknown') // P1-1：失效态失败必须保留 unknown
    }
    expect(gens.size).toBe(0)
  })
})

describe('P1-3 对账 API 校验 fingerprint（冲突拒绝且保持原状态）', () => {
  // 反例场景：A/B 共享**显式 key**（keyArg=orderId → explicit:k1），仅参数不同
  // （fingerprint 不同）——当前代码 release/confirm/invalidate 只看 key，会误操作对方记录。
  const rules = [{ tool: 'create_order', keyArg: 'orderId' }]

  it('反例：A 进入 unknown 后，release(B)（不同参数）不得解除 A；重试 A 仍被阻止', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      throw new Error('boom')
    })
    await executeTool(ctx, 'create_order', { orderId: 'k1', amount: 10 }) // A → unknown
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })?.state).toBe('unknown')
    // B：同 key 不同参数（amount=999）→ fingerprint 不同 → release 必须拒绝且保持原状态
    idempotencyApi(ctx).release('create_order', { orderId: 'k1', amount: 999 })
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })?.state).toBe('unknown')
    const retry = await executeTool(ctx, 'create_order', { orderId: 'k1', amount: 10 })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1) // 副作用未重复
    // 正确参数 release 才能解除
    idempotencyApi(ctx).release('create_order', { orderId: 'k1', amount: 10 })
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })).toBeUndefined()
  })

  it('confirm(B) 不得覆盖 A 的 unknown；confirm(A) 才写入验证结果', async () => {
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => {
      throw new Error('boom')
    })
    await executeTool(ctx, 'create_order', { orderId: 'k2', amount: 10 }) // A → unknown
    const verified: ToolExecutionResult = {
      isError: false,
      content: [{ type: 'text', text: 'verified-committed' }],
      value: [{ type: 'text', text: 'verified-committed' }],
    }
    // B：不同参数 confirm → 拒绝且保持 unknown
    idempotencyApi(ctx).confirm('create_order', { orderId: 'k2', amount: 999 }, verified)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k2', amount: 10 })?.state).toBe('unknown')
    // A：正确参数 confirm → 写入验证结果（可重放）
    idempotencyApi(ctx).confirm('create_order', { orderId: 'k2', amount: 10 }, verified)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k2', amount: 10 })?.state).toBe('succeeded')
    const replay = await executeTool(ctx, 'create_order', { orderId: 'k2', amount: 10 })
    expect(replay).toMatchObject({ isError: false })
  })

  it('invalidate(B) 不得清除 A 的 succeeded；invalidate(A) 才失效', async () => {
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => [{ type: 'text', text: 'ok' }])
    await executeTool(ctx, 'create_order', { orderId: 'k3', amount: 10 }) // A → succeeded
    // B：不同参数 invalidate → 拒绝且保持 succeeded（仍可重放）
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k3', amount: 999 })
    const qAfterB = idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })
    expect(qAfterB?.state).toBe('succeeded')
    // A：正确参数 invalidate → 缓存失效
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k3', amount: 10 })
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })).toBeUndefined()
  })
})

describe('P1-3a/3b fencing token（executionId 永不回退，P1-3 关闭前提）', () => {
  // 规格来源：负责人评审——generation 因清理被复用（ABA），「generation 相等 ≠ 同一执行」；
  // fencing 契约：executionId 是每轮执行分配、永不回退且在生命周期内唯一的 token；
  // query 返回与 release/confirm/invalidate 校验必须**同源**（都读记录本身的 executionId）。
  const rules = [{ tool: 'create_order', keyArg: 'orderId' }]

  it('Case 1：executionId 不允许复用（两轮执行 token 不同）', () => {
    const store = new MemoryStore(10, 10, 10)
    const r1 = store.reserve('A', 'fp-A')
    expect(r1).not.toBeNull()
    store.settle('A', r1!.owner, okResult(1), 1000)
    const e1 = store.get('A')!.executionId // 第一轮 succeeded 记录
    const r2 = store.reserve('A', 'fp-A')
    expect(r2).not.toBeNull()
    const e2 = store.get('A')!.executionId // 第二轮 executing 记录
    expect(e2).not.toBe(e1) // UUID 永不回退
  })

  it('Case 2（P1-3b 核心反例）：ABA stale release 不能命中新一轮执行', async () => {
    let attempts = 0
    let call = 0
    const gateA = deferred<unknown>() // A 轮执行的门（先失败）
    const gateB = deferred<unknown>() // B 轮执行的门（保持 executing 挂起）
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      call += 1
      await (call === 1 ? gateA : gateB).promise
      throw new Error('boom')
    })
    // 执行 A（g1）：reserve → invalidate → release（执行中解除）
    const p1 = executeTool(ctx, 'create_order', { orderId: 'k1', amount: 10 })
    await until(() => attempts === 1)
    const g1 = idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })!.executionId
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k1', amount: 10 })
    idempotencyApi(ctx).release('create_order', { orderId: 'k1', amount: 10 })
    gateA.reject(new Error('boom'))
    await p1.catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })).toBeUndefined() // A 已解除
    // 新一轮执行 B（g2）：挂起在 gateB，保持 executing
    const p2 = executeTool(ctx, 'create_order', { orderId: 'k1', amount: 10 })
    await until(() => attempts === 2)
    // 网络中迟到的旧对账：release(expectedExecutionId=g1) 必须拒绝（ABA）
    const stale = idempotencyApi(ctx).release(
      'create_order',
      { orderId: 'k1', amount: 10 },
      { expectedExecutionId: g1 },
    )
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('GENERATION_MISMATCH')
    // 新执行仍存在且属于 g2（未被旧对账解除/污染）
    const stateB = idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })
    expect(stateB?.state).toBe('executing')
    expect(stateB?.executionId).not.toBe(g1)
    gateB.reject(new Error('boom'))
    await p2.catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k1', amount: 10 })?.state).toBe('unknown') // B 自己失败 → unknown（g2）
  })

  it('Case 3：query → release round trip（中间无状态变化必须成功，同源一致）', async () => {
    let attempts = 0
    const gate = deferred<unknown>()
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      await gate.promise
      throw new Error('boom')
    })
    const p = executeTool(ctx, 'create_order', { orderId: 'k2', amount: 10 })
    await until(() => attempts === 1)
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'k2', amount: 10 })
    const state = idempotencyApi(ctx).query('create_order', { orderId: 'k2', amount: 10 })!
    expect(state.state).toBe('executing')
    // 用 query 返回的 fingerprint + executionId 对账：无状态变化时必须成功
    const rel = idempotencyApi(ctx).release(
      'create_order',
      { orderId: 'k2', amount: 10 },
      { expectedExecutionId: state.executionId },
    )
    expect(rel).toMatchObject({ ok: true })
    gate.reject(new Error('boom'))
    await p.catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k2', amount: 10 })).toBeUndefined()
  })

  it('Case 4：stale confirm/release/invalidate 不能污染新一轮执行（fencing 一致覆盖三个对账方法）', async () => {
    let attempts = 0
    let call = 0
    const gateA = deferred<unknown>() // A 轮执行的门（先失败进 unknown）
    const gateB = deferred<unknown>() // B 轮执行的门（保持 executing 挂起）
    const ctx = await toolHarness({ rules })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      call += 1
      await (call === 1 ? gateA : gateB).promise
      throw new Error('boom')
    })
    // A(g1) → unknown
    const p1 = executeTool(ctx, 'create_order', { orderId: 'k3', amount: 10 })
    await until(() => attempts === 1)
    gateA.reject(new Error('boom'))
    await p1.catch(() => undefined)
    const g1 = idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })!.executionId
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })?.state).toBe('unknown')
    // 正确 token 对账解除 A
    expect(
      idempotencyApi(ctx).release('create_order', { orderId: 'k3', amount: 10 }, { expectedExecutionId: g1 }).ok,
    ).toBe(true)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })).toBeUndefined()
    // B(g2) running：挂起在 gateB，保持 executing
    const p2 = executeTool(ctx, 'create_order', { orderId: 'k3', amount: 10 })
    await until(() => attempts === 2)
    // 迟到的旧对账（expectedExecutionId=g1）：confirm/release/invalidate 全部拒绝
    const verified: ToolExecutionResult = {
      isError: false,
      content: [{ type: 'text', text: 'verified' }],
      value: [{ type: 'text', text: 'verified' }],
    }
    const c = idempotencyApi(ctx).confirm('create_order', { orderId: 'k3', amount: 10 }, verified, {
      expectedExecutionId: g1,
    })
    expect(c.ok).toBe(false)
    expect(c.error).toContain('GENERATION_MISMATCH')
    const r = idempotencyApi(ctx).release('create_order', { orderId: 'k3', amount: 10 }, { expectedExecutionId: g1 })
    expect(r.ok).toBe(false)
    const i = idempotencyApi(ctx).invalidate('create_order', { orderId: 'k3', amount: 10 }, { expectedExecutionId: g1 })
    expect(i.ok).toBe(false)
    // 新执行仍存在且属于 g2
    const stateB = idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })
    expect(stateB?.state).toBe('executing')
    expect(stateB?.executionId).not.toBe(g1)
    gateB.reject(new Error('boom'))
    await p2.catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3', amount: 10 })?.state).toBe('unknown') // B 自己失败 → unknown（g2）
  })
})
