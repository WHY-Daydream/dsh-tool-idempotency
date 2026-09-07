/**
 * Phase 2 业务正确性 · 方向 8：业务状态变化。
 *
 * 场景：首次成功后被外部修改或补偿。
 * 验收：不把已失效的缓存结果当作当前业务事实。
 *
 * 0.1.3 已知限制（K2，acceptance-c 实测）：补偿成功后同业务 key 请求会被
 * 重放旧「已创建」成功结果——本套件以确定性用例实证该行为，并验证现有
 * 缓解路径（inFlightOnly / 新 key / TTL 过期）确实能观察到新业务状态。
 * 每个用例同时断言：副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import { executeTool, registerTool, toolHarness } from './harness.js'

describe('业务状态变化：补偿后不得把失效缓存当业务事实', () => {
  it('K2 实证：首次成功后外部补偿，同 key 重试仍重放旧「已创建」结果（0.1.3 已知限制）', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: attempts === 1 ? 'order created' : 'order re-created' }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order created' }] })
    // 外部补偿：业务状态已变（订单被取消），但缓存仍持有「已创建」
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    console.log('[K2] 补偿后同 key 重试结果：', JSON.stringify(r2), 'attempts=', attempts)
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order created' }] }) // 重放失效缓存
    expect(attempts).toBe(1) // 旧结果被当作业务事实 → 业务正确性 FAIL（已知限制，0.2.0 invalidate/代次方向）
    expect(records).toEqual(['exec-1'])
  })

  it('inFlightOnly：不重放缓存，重试重新执行，能观察到外部修改后的新业务状态', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
    registerTool(ctx, 'send_email', async () => {
      attempts += 1
      return [{ type: 'text', text: attempts === 1 ? 'state=active' : 'state=cancelled' }]
    })

    const r1 = await executeTool(ctx, 'send_email', { to: 'a@x' })
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'state=active' }] })
    // 外部把业务状态改为 cancelled（同 key 重试：inFlightOnly 不重放 → 重新执行）
    const r2 = await executeTool(ctx, 'send_email', { to: 'a@x' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'state=cancelled' }] })
    expect(attempts).toBe(2) // 观察到新业务状态
  })

  it('补偿后业务换新 key（新操作身份）：独立执行，不重放旧缓存', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    await executeTool(ctx, 'create_order', { requestId: 'r2', orderId: 'a' }) // 补偿后新操作身份
    expect(attempts).toBe(2) // 新 key 独立执行

    const r1again = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    expect(r1again).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] }) // 旧 key 仍重放旧结果
    expect(attempts).toBe(2)
  })

  it('TTL 到期后重试返回当前业务状态（不再重放失效旧结果）', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: attempts === 1 ? 'status=created' : 'status=cancelled-after-external-change' }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'status=created' }] })
    await new Promise((resolve) => setTimeout(resolve, 1100)) // 跨 TTL 窗口
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'status=cancelled-after-external-change' }] })
    expect(attempts).toBe(2) // 过期后重新执行，观察到新状态
  })

  it('探测：0.1.3 无公开缓存失效/代次接口（0.2.0 invalidate 方向的前置事实）', async () => {
    const api = await import('../../src/index.js') as Record<string, unknown>
    const exported = Object.keys(api).sort()
    console.log('[PROBE] plugin exports:', exported.join(','))
    expect(exported).toContain('apply')
    expect(exported).not.toContain('invalidate') // 0.1.3 无失效接口：外部无法主动失效缓存
  })
})
