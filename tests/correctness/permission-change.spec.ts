/**
 * Phase 2 业务正确性 · 方向 5：权限变化。
 *
 * 场景：首次允许，重试时权限被撤销。
 * 验收：缓存命中不能绕过当前权限检查。
 *
 * dsh-tools 管线顺序（源码确认）：`tools/pre-execute` 决策瀑布 + ToolGuard
 * 单调拒绝（prepare 阶段）先于 `tools/execute` around-dispatch 瀑布——
 * idempotency 插件监听的是 `tools/execute`。因此权限门对每一次调用
 * （含缓存命中调用）都先于 idempotency 执行。
 *
 * 每个用例同时断言：副作用次数、返回结果、幂等状态、权限门调用记录。
 */

import { describe, expect, it } from 'vitest'
import { executeTool, registerTool, toolHarness } from './harness.js'

describe('权限变化：缓存命中不得绕过权限检查', () => {
  it('命中缓存时权限检查仍然执行（pre-execute 门调用次数不因重放而减少）', async () => {
    let gateChecks = 0
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    ctx.on('tools/pre-execute', async (_exec, next) => {
      gateChecks += 1
      return next()
    })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(gateChecks).toBe(1)

    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 缓存命中（重放）
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1) // 副作用仍只一次
    expect(gateChecks).toBe(2) // 权限检查在缓存命中路径上仍执行，未被绕过
  })

  it('首次允许、重试时权限被撤销：缓存命中被拒绝而非重放旧结果', async () => {
    let allowed = true
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    ctx.on('tools/pre-execute', async (_exec, next) => {
      if (!allowed) return { kind: 'deny', reason: 'permission-revoked' }
      return next()
    })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 首次允许
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })

    allowed = false // 权限撤销
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 本可命中缓存
    expect(r2).toMatchObject({ isError: true }) // 必须被权限拒绝，而非重放缓存
    expect(JSON.stringify(r2)).toContain('permission-revoked')
    expect(attempts).toBe(1) // 拒绝未产生新副作用
  })

  it('ToolGuard 撤销同样在缓存命中时生效（guard 先于 idempotency 监听）', async () => {
    let allowed = true
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    ctx.tools.guard(() => (allowed ? undefined : 'guard-revoked'))
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })

    allowed = false
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 缓存命中路径
    expect(r2).toMatchObject({ isError: true }) // guard 拒绝先于重放
    expect(JSON.stringify(r2)).toContain('guard-revoked')
    expect(attempts).toBe(1)
  })
})
