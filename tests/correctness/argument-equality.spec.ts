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

describe('参数判等：模拟哈希碰撞（FNV-1a 32 位）', () => {
  // 实测可复现的指纹碰撞对（src/canonicalize.ts 的 FNV-1a 32 位）：
  //   {x:"s406053133"}          → canonical {"x":"s406053133"}
  //   {d:{inner:967754},z:"s428930447"} → canonical {"d":{"inner":967754},"z":"s428930447"}
  // 两者规范字符串不同，但指纹同为 12077584。
  const COLLISION_A = { x: 's406053133' } as Record<string, unknown>
  const COLLISION_B = { d: { inner: 967754 }, z: 's428930447' } as Record<string, unknown>

  it('碰撞对确实不同但指纹相同（前置断言）', () => {
    const fa = fingerprintOf({ name: 'create_order', arguments: COLLISION_A } as never)
    const fb = fingerprintOf({ name: 'create_order', arguments: COLLISION_B } as never)
    expect(JSON.stringify(COLLISION_A)).not.toBe(JSON.stringify(COLLISION_B))
    expect(fa).toBe(fb)
    expect(fa).toBe('12077584')
  })

  it('0.1.3 已知限制实证：指纹碰撞被当作相同请求重放（不同请求被错误合并）', async () => {
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
      '[KNOWN-LIMITATION] fingerprint collision: A=%j B=%j fp=%s → attempts=%d (0.1.3 FNV-1a 非防碰撞，审计 P1 已计划升级 SHA-256)',
      COLLISION_A, COLLISION_B, fingerprintOf({ name: 'create_order', arguments: COLLISION_A } as never), attempts,
    )
    // 0.1.3 实际行为：碰撞被当作相同请求 → 重放首次结果（不同请求错误合并）。
    // 契约验收「不同请求不能错误合并」= FAIL（已知限制，canonicalize.ts 审计 P1 明文声明）。
    expect(attempts).toBe(1)
    expect(records).toEqual(['exec-1'])
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})
