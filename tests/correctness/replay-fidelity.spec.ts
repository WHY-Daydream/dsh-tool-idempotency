/**
 * Phase 2 业务正确性 · 方向 4：结果重放。
 *
 * 场景：value、多模态内容、附加字段、错误身份不复制。
 * 验收：保留应重放内容（与首次结果完全一致），不复制错误身份/一次性执行身份。
 *
 * 每个用例同时断言：实际副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { executeTool, idempotencyApi, registerTool, toolHarness } from './harness.js'

describe('结果重放：内容保真', () => {
  it('多模态 content（text + reasoning 混合）完整重放，与首次结果深度相等', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [
        { type: 'text', text: `order-${attempts} created` },
        { type: 'reasoning', text: 'verified stock' },
        { type: 'text', text: 'done' },
      ] as ContentBlock[]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1) // 幂等状态：succeeded → 重放
    expect(r2).toEqual(r1) // 重放结果与首次结果完全一致（多模态块保真）
    expect(r2).toMatchObject({
      isError: false,
      content: [
        { type: 'text', text: 'order-1 created' },
        { type: 'reasoning', text: 'verified stock' },
        { type: 'text', text: 'done' },
      ],
    })
  })

  it('重放返回首次执行的原始结果（含执行时生成的一次性随机身份），不重新生成', async () => {
    let attempts = 0
    let firstToken = ''
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      firstToken = `tok-${Math.random().toString(36).slice(2)}-${Date.now()}`
      return [{ type: 'text', text: `order token=${firstToken}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1)
    expect(JSON.stringify(r1)).toContain(firstToken)
    expect(JSON.stringify(r2)).toContain(firstToken) // 重放原始结果，一次性身份未重新生成
  })

  it('succeeded 状态持续：TTL 内多次调用全部重放首次结果', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    for (let i = 0; i < 5; i += 1) {
      const r = await executeTool(ctx, 'create_order', { orderId: 'a' })
      expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    }
    expect(attempts).toBe(1) // 连续 6 次调用，副作用仅一次
  })
})

describe('结果重放：错误身份不复制', () => {
  it('isError 结果不缓存且转 unknown：重试被阻止（错误不被重放/不重新执行）；release 后执行新结果', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error(`unique-err-${attempts}`)
      return [{ type: 'text', text: `ok-${attempts}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: true }) // 宿主把 guard 传播的失败映射为 isError 结果
    expect(JSON.stringify(r1)).toContain('unique-err-1')

    // 0.2.0：无提交证据的错误 → unknown；重试被阻止且错误不被重放
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(JSON.stringify(r2)).not.toContain('unique-err') // 错误身份未被复制进重试结果
    expect(attempts).toBe(1) // 未盲目重新执行

    idempotencyApi(ctx).release('create_order', { orderId: 'a' })
    const r3 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r3).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ok-2' }] })
    expect(attempts).toBe(2) // 解除后重新执行
    expect(JSON.stringify(r3)).not.toContain('unique-err')
  })

  it('失败后的成功结果同样被缓存重放（先失败→unknown→release 后成功，成功结果可复用）', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom-first')
      return [{ type: 'text', text: 'order-committed' }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }) // 首次失败 → unknown
    const blocked = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(blocked).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)

    idempotencyApi(ctx).release('create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ content: [{ type: 'text', text: 'order-committed' }] })
    const r3 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r3).toMatchObject({ content: [{ type: 'text', text: 'order-committed' }] })
    expect(attempts).toBe(2) // 第 2 次成功后被缓存，第 3 次重放
  })
})

describe('结果重放：附加字段形状探测（如实记录，不宣称支持）', () => {
  it('探测宿主物化结果的字段形状并验证重放完整保真', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'order' }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' }) as Record<string, unknown>
    console.log(
      '[PROBE] materialized result keys=%j value?=%s meta?=%s additionalContexts?=%s',
      Object.keys(r1),
      r1.value !== undefined,
      r1.meta !== undefined,
      r1.additionalContexts !== undefined,
    )
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1)
    expect(r2).toEqual(r1) // 重放完整保真：结果对象所有字段与首次一致
  })
})
