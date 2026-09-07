/**
 * Phase 2 业务正确性 · 方向 7：缓存边界。
 *
 * 场景：TTL 边界、缓存满、在途满、大结果、执行锁不淘汰。
 * 验收：不淘汰执行锁，拒绝与过期行为符合契约。
 *
 * TTL 用真实时钟（插件内部 store 的 now 不可注入），sleep 仅用于跨过期窗口；
 * 并发用例仍使用 started/joined/committed 屏障。每个用例同时断言：
 * 副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deferred, executeTool, registerTool, tick, toolHarness, until } from './harness.js'

describe('缓存边界：TTL 边界', () => {
  it('TTL 到期前重放，到期后重新执行', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // TTL 内
    expect(r2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 1100)) // 跨过期窗口
    const r3 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // TTL 外
    expect(r3).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2)
  })

  it('执行锁不受 TTL 影响：owner 挂起超过 TTL，同 key 重试仍 join 而非重新执行', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started
    await new Promise((resolve) => setTimeout(resolve, 1100)) // owner 挂起超过 TTL 窗口
    const retry = executeTool(ctx, 'create_order', { orderId: 'a' }) // 必须 join，不能因 TTL 过期重新执行
    await tick(10)
    expect(attempts).toBe(1) // 执行锁未被 TTL 淘汰
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed
    const [rOwner, rRetry] = await Promise.all([owner, retry])
    expect(attempts).toBe(1)
    expect(rOwner).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(rRetry).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
  })
})

describe('缓存边界：缓存满（maxEntries FIFO 淘汰）', () => {
  it('超上限时 FIFO 淘汰最旧缓存；被淘汰 key 重新执行，未淘汰 key 仍重放', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxEntries: 2 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }) // exec-1 → cache a
    await executeTool(ctx, 'create_order', { orderId: 'b' }) // exec-2 → cache b（满 2）
    await executeTool(ctx, 'create_order', { orderId: 'c' }) // exec-3 → FIFO 淘汰 a；cache {b, c}
    // 先断言未被淘汰的 b 仍重放；再断言被淘汰的 a 重新执行（a 重新写入会再 FIFO 淘汰 b）
    const rb = await executeTool(ctx, 'create_order', { orderId: 'b' })
    expect(rb).toMatchObject({ content: [{ type: 'text', text: 'order-2' }] })
    const ra = await executeTool(ctx, 'create_order', { orderId: 'a' }) // a 被淘汰 → 重新执行
    expect(ra).toMatchObject({ content: [{ type: 'text', text: 'order-4' }] })
    expect(attempts).toBe(4)
    expect(records).toEqual(['exec-1', 'exec-2', 'exec-3', 'exec-4'])
  })

  it('缓存压力不淘汰执行锁：maxEntries=1 时并发 A 执行锁在 B 写入后仍存活（重试 join）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxEntries: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) return gate.promise // A：挂起占用执行锁
      return [{ type: 'text', text: `order-${attempts}` }] // B 及之后立即完成
    })
    const a1 = executeTool(ctx, 'create_order', { orderId: 'a' }) // A claims（attempt 1）
    await until(() => attempts === 1) // started
    const b1 = await executeTool(ctx, 'create_order', { orderId: 'b' }) // B 完成，填满缓存（attempt 2）
    expect(b1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    const a2 = executeTool(ctx, 'create_order', { orderId: 'a' }) // A 的重试必须 join，不得被缓存压力淘汰
    await tick(10)
    expect(attempts).toBe(2) // A2 未执行
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed
    const [ra1, ra2] = await Promise.all([a1, a2])
    expect(attempts).toBe(2) // A 执行一次、B 执行一次；A 的重试被去重
    expect(ra1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(ra2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
  })
})

describe('缓存边界：在途满（maxInFlight）', () => {
  it('新 key 被容量拒绝且不执行副作用；owner 完成后恢复可执行', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const first = executeTool(ctx, 'create_order', { orderId: 'a' }) // 占用唯一执行槽
    await until(() => attempts === 1)
    const refused = await executeTool(ctx, 'create_order', { orderId: 'b' }) // 新 key → 容量拒绝
    expect(refused).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_CAPACITY_REJECTED', name: 'IdempotencyCapacityRejected' } },
    })
    expect(attempts).toBe(1) // 被拒调用未到达工具
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed
    await first
    const after = await executeTool(ctx, 'create_order', { orderId: 'b' }) // 槽释放 → 可执行
    expect(after).toMatchObject({ isError: false })
    expect(attempts).toBe(2) // 恢复后正常执行
  })

  it('在途满时同 key 重试仍 join，不被容量拒绝', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const a1 = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1)
    const a2 = executeTool(ctx, 'create_order', { orderId: 'a' }) // 同 key → join
    await tick(10)
    expect(attempts).toBe(1)
    const refused = await executeTool(ctx, 'create_order', { orderId: 'b' }) // 新 key → 拒绝
    expect(refused).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_CAPACITY_REJECTED' } } })
    expect(attempts).toBe(1)
    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [ra1, ra2] = await Promise.all([a1, a2])
    expect(attempts).toBe(1)
    expect(ra1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(ra2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
  })
})

describe('缓存边界：大结果', () => {
  it('大结果（约 2MB content）可缓存并完整重放', async () => {
    let attempts = 0
    const bigText = 'x'.repeat(2 * 1024 * 1024)
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: attempts === 1 ? bigText : 'wrong' }] as ContentBlock[]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1) // 大结果被缓存，未重新执行
    expect(r2).toEqual(r1) // 完整重放（含 2MB content）
    expect(JSON.stringify(r2)).toContain('"x'.slice(0, 1))
  })
})
