/**
 * Phase 2 业务正确性 · 方向 2：参数判等。
 *
 * 场景：特殊 JSON 字段、嵌套参数、数组顺序、模拟哈希碰撞。
 * 验收：不同请求不能错误合并；相同请求（含键序/深层规范化等价）正确去重。
 *
 * 每个用例同时断言：实际副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import { fingerprintOf } from '../../src/canonicalize.js'
import { executeTool, registerTool, toolHarness } from './harness.js'

describe('参数判等：特殊 JSON 字段', () => {
  it('`__proto__` 自有字段（JSON.parse 合法数据）与普通请求是不同请求，不错误合并', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>
    const without = JSON.parse('{"a":1}') as Record<string, unknown>
    await executeTool(ctx, 'create_order', withProto)
    await executeTool(ctx, 'create_order', without)
    expect(records).toEqual(['exec', 'exec']) // 不同请求，各自执行，无串用
    const replay = await executeTool(ctx, 'create_order', withProto)
    expect(records).toEqual(['exec', 'exec']) // 相同请求（含特殊字段）正确去重
    expect(replay).toMatchObject({ isError: false })
  })

  it('`constructor` / `prototype` 自有字段与普通请求是不同请求', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    const withCtor = JSON.parse('{"constructor":{"name":"x"},"a":1}') as Record<string, unknown>
    const withProtoKey = JSON.parse('{"prototype":{"y":2},"a":1}') as Record<string, unknown>
    const plain = { a: 1 } as Record<string, unknown>
    await executeTool(ctx, 'create_order', withCtor)
    await executeTool(ctx, 'create_order', withProtoKey)
    await executeTool(ctx, 'create_order', plain)
    expect(records).toEqual(['exec', 'exec', 'exec'])
  })
})

describe('参数判等：嵌套参数', () => {
  it('深层嵌套值不同 → 不同请求，各自执行；深层嵌套相同 → 去重', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { a: { b: { c: 1 } } })
    await executeTool(ctx, 'create_order', { a: { b: { c: 2 } } })
    expect(records).toEqual(['exec', 'exec'])
    const replay = await executeTool(ctx, 'create_order', { a: { b: { c: 1 } } })
    expect(records).toEqual(['exec', 'exec'])
    expect(replay).toMatchObject({ isError: false })
  })

  it('嵌套对象键序不同 → 规范化等价，去重', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { a: { x: 1, y: 2 }, b: 3 })
    await executeTool(ctx, 'create_order', { b: 3, a: { y: 2, x: 1 } })
    expect(records).toEqual(['exec'])
  })
})

describe('参数判等：数组顺序', () => {
  it('数组顺序不同 → 不同请求（JSON 语义顺序敏感），各自执行', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { list: [1, 2] })
    await executeTool(ctx, 'create_order', { list: [2, 1] })
    expect(records).toEqual(['exec', 'exec'])
  })

  it('数组内对象的键序不同 → 深度规范化后等价，去重', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { items: [{ a: 1, b: 2 }, { c: 3 }] })
    await executeTool(ctx, 'create_order', { items: [{ b: 2, a: 1 }, { c: 3 }] })
    expect(records).toEqual(['exec'])
  })
})

describe('参数判等：边界值', () => {
  it('null / 0 / 空串 / false 互不相同，不得合并', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { x: null })
    await executeTool(ctx, 'create_order', { x: 0 })
    await executeTool(ctx, 'create_order', { x: '' })
    await executeTool(ctx, 'create_order', { x: false })
    expect(records).toEqual(['exec', 'exec', 'exec', 'exec'])
    // 相同边界值去重
    await executeTool(ctx, 'create_order', { x: 0 })
    expect(records).toEqual(['exec', 'exec', 'exec', 'exec'])
  })
})

describe('参数判等：哈希碰撞回归（0.2.0 SHA-256 修复 O1）', () => {
  // 0.1.3 FNV-1a 实测可复现的指纹碰撞对（审计 P1/O1）：
  //   {x:"s406053133"}          → canonical {"x":"s406053133"}
  //   {d:{inner:967754},z:"s428930447"} → canonical {"d":{"inner":967754},"z":"s428930447"}
  // 两者规范字符串不同；0.1.3 下指纹同为 12077584 → 不同请求被错误合并重放。
  // 0.2.0 升级 SHA-256 后该对必须区分。
  const COLLISION_A = { x: 's406053133' } as Record<string, unknown>
  const COLLISION_B = { d: { inner: 967754 }, z: 's428930447' } as Record<string, unknown>

  it('碰撞对在 SHA-256 下指纹不同（前置断言）', () => {
    const fa = fingerprintOf({ name: 'create_order', arguments: COLLISION_A } as never)
    const fb = fingerprintOf({ name: 'create_order', arguments: COLLISION_B } as never)
    expect(JSON.stringify(COLLISION_A)).not.toBe(JSON.stringify(COLLISION_B))
    expect(fa).not.toBe(fb)
    expect(fa).toMatch(/^v1:[0-9a-f]{64}$/)
  })

  it('0.2.0 修复实证：碰撞对不同请求不再错误合并（各自执行，无重放串用）', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', COLLISION_A)
    const r2 = await executeTool(ctx, 'create_order', COLLISION_B)
    console.log(
      '[O1-FIXED] collision pair: A=%j B=%j fpA=%s fpB=%s → attempts=%d (SHA-256 下该实测碰撞对不再碰撞，各自执行；非绝对免碰撞)',
      COLLISION_A, COLLISION_B,
      fingerprintOf({ name: 'create_order', arguments: COLLISION_A } as never),
      fingerprintOf({ name: 'create_order', arguments: COLLISION_B } as never),
      attempts,
    )
    // 契约验收「不同请求不能错误合并」= PASS（0.2.0 修复）
    expect(attempts).toBe(2)
    expect(records).toEqual(['exec-1', 'exec-2'])
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    // 各自可独立重放
    const replayB = await executeTool(ctx, 'create_order', COLLISION_B)
    expect(attempts).toBe(2)
    expect(replayB).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
  })
})
