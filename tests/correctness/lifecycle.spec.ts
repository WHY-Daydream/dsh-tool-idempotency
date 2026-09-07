/**
 * Phase 2 业务正确性 · 方向 6：插件生命周期。
 *
 * 场景：卸载、重新挂载、执行中卸载。
 * 验收：行为明确，无重复监听和无法释放的资源。
 *
 * cordis 契约（源码确认）：`ctx.plugin()` 返回 PromiseLike<Fiber>，`fiber.dispose()`
 * 卸载插件并自动移除其注册的事件监听器。卸载不触碰 in-flight promise，owner 可正常结算。
 *
 * 每个用例同时断言：副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Idempotency from '../../src/index.js'
import type { Config } from '../../src/index.js'
import { deferred, executeTool, registerTool, tick, toolHarness, until } from './harness.js'

/** 手动挂载以便拿到 idempotency 的 fiber disposer。 */
async function lifecycleHarness(config: Config = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(Idempotency, config)
  return { ctx, dispose: () => fiber.dispose() }
}

describe('插件生命周期：卸载', () => {
  it('卸载后 guard 失效：同 key 重新执行（无残留监听器）', async () => {
    let attempts = 0
    const records: string[] = []
    const { ctx, dispose } = await lifecycleHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(attempts).toBe(1)
    await dispose() // 卸载：监听器随 fiber 卸载自动移除

    const r = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 同 key 直通
    expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // guard 不再拦截
    expect(records).toEqual(['exec-1', 'exec-2'])
  })

  it('重复卸载幂等：dispose 两次无异常', async () => {
    const { dispose } = await lifecycleHarness({ rules: [{ tool: 'create_order' }] })
    await dispose()
    await dispose() // 二次卸载不得抛错
  })
})

describe('插件生命周期：重新挂载', () => {
  it('重新挂载后是新 store：旧缓存不复用，同 key 重新执行并在新 store 内去重', async () => {
    let attempts = 0
    const records: string[] = []
    const { ctx, dispose } = await lifecycleHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1)

    await dispose()
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] }) // 重新挂载

    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ content: [{ type: 'text', text: 'order-2' }] }) // 新 store：重新执行
    expect(attempts).toBe(2)
    const r3 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r3).toMatchObject({ content: [{ type: 'text', text: 'order-2' }] }) // 新 store 内去重
    expect(attempts).toBe(2)
    expect(records).toEqual(['exec-1', 'exec-2'])
  })

  it('重挂后无重复监听：并发同 key 仍 join 一次，不重复执行', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const { ctx, dispose } = await lifecycleHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    await dispose()
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] }) // 重新挂载

    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started
    const joiner = executeTool(ctx, 'create_order', { orderId: 'a' }) // joined
    await tick(10)
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed
    const [ro, rj] = await Promise.all([owner, joiner])
    expect(attempts).toBe(1) // 仅一个 guard 实例：join 生效，无重复 claim/执行
    expect(ro).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(rj).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})

describe('插件生命周期：执行中卸载', () => {
  it('owner 执行中卸载插件：owner 正常结算、无异常；此后调用直通', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const { ctx, dispose } = await lifecycleHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started：owner 挂起
    await dispose() // 执行中卸载：不触碰 in-flight promise

    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed：owner 结算
    const rOwner = await owner
    expect(rOwner).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] }) // 正常结算，无 unhandled rejection

    const r = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 卸载后直通
    expect(r).toMatchObject({ isError: false })
    expect(attempts).toBe(2) // 无残留 guard：新调用是真实执行
  })
})

describe('插件生命周期：重复挂载同一插件', () => {
  it('同一 ctx 重复 plugin() 不产生双重拦截（同 key 并发仍 join 一次）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] }) // 第二次挂载（同一 callback）
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1)
    const joiner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await tick(10)
    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [ro, rj] = await Promise.all([owner, joiner])
    expect(attempts).toBe(1) // 双挂载未导致双重执行或 duplicate-claim 错误
    expect(ro).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(rj).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})
