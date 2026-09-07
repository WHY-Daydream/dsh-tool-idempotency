/**
 * Phase 3 组合测试 · bulkhead + idempotency（本地 link 宿主）。
 *
 * 场景：排队、容量拒绝、同 key 合并是否相互干扰。
 * 组合语义：两者都是 `tools/execute` 包装，注册顺序决定链外层：
 * - bulkhead-first：bulkhead 先看调用 → 同 key 重试进入 bulkhead 队列/被拒，
 *   idempotency 的 join 只有在通过 bulkhead 准入后才可达——组合干扰观察。
 * - idempotency-first：同 key 先 join（不进入 bulkhead），新 key 才受 bulkhead 约束。
 * owner 用 deferred gate 控制结算；等待加 2s 护栏。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Bulkhead from '@why-daydream/dsh-tool-bulkhead'
import * as Idempotency from '../../src/index.js'
import { deferred, executeTool, tick, until } from './harness.js'

/** 2s 安全护栏。 */
async function withinGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`GUARD: ${label} hung >2s`)), 2000)),
  ])
}

/** 单槽 + 单排队位 + 满则拒：rule 只声明 `tool`（bulkhead 校验：`tool` 或 `domain+tools` 二选一）。 */
const BH_SINGLE = {
  defaults: { maxConcurrent: 1, maxQueue: 1, queueTimeout: 1000, rejectWhenFull: true },
  rules: [{
    tool: 'create_order',
    maxConcurrent: 1,
    maxQueue: 1,
    queueTimeout: 1000,
    rejectWhenFull: true,
  }],
}

async function bulkheadHarness(order: 'bulkhead-first' | 'idempotency-first'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (order === 'bulkhead-first') {
    await ctx.plugin(Bulkhead, BH_SINGLE)
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] })
  } else {
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] })
    await ctx.plugin(Bulkhead, BH_SINGLE)
  }
  return ctx
}

describe('组合：bulkhead（外层，先注册） + idempotency（内层）', () => {
  it('同 key 重试进入 bulkhead 队列而非 idempotency join（组合干扰观察）；队列满拒新 key；槽位释放后重放恢复', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await bulkheadHarness('bulkhead-first')
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create_order',
      parameters: {},
      async execute() {
        attempts += 1
        if (attempts === 1) return gate.promise // 占用 bulkhead 唯一执行槽
        return [{ type: 'text', text: `order-${attempts}` }]
      },
    }))

    const a1 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a1')
    await until(() => attempts === 1) // started
    const a2 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a2') // 同 key → bulkhead 排队（非 join）
    await tick(50)
    expect(attempts).toBe(1) // a2 排队中未执行（bulkhead 外层拦截了 idempotency 的 join）
    const b1 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'b' }), 'b1') // 新 key → 队列满 → 拒绝
    expect(b1).toMatchObject({ isError: true, error: { info: { code: 'BULKHEAD_REJECTED' } } })
    expect(attempts).toBe(1)

    gate.resolve([{ type: 'text', text: 'order-1' }]) // 释放槽位
    const [rA1, rA2] = await Promise.all([a1, a2])
    expect(rA1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(rA2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] }) // a2 通过 bulkhead 后到达 idempotency → 重放
    expect(attempts).toBe(1) // a2 未重复执行
    const b1retry = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'b' }), 'b1-retry')
    expect(b1retry).toMatchObject({ isError: false }) // 槽位释放后新 key 可执行
    expect(attempts).toBe(2)
  })

  it('排队（maxQueue=2, rejectWhenFull=true）：a2/b1 排队不执行，队列满后 c1 被拒；槽位释放后排队调用恢复', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Bulkhead, {
      defaults: { maxConcurrent: 1, maxQueue: 2, queueTimeout: 5000, rejectWhenFull: true },
      rules: [{
        tool: 'create_order',
        maxConcurrent: 1,
        maxQueue: 2,
        queueTimeout: 5000,
        rejectWhenFull: true,
      }],
    })
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] })
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order', description: 'create_order', parameters: {},
      async execute() {
        attempts += 1
        if (attempts === 1) return gate.promise
        return [{ type: 'text', text: `order-${attempts}` }]
      },
    }))

    const a1 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a1')
    await until(() => attempts === 1)
    const a2 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a2') // 同 key → 排队（非 join）
    const b1 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'b' }), 'b1') // 新 key → 排队
    await tick(50)
    expect(attempts).toBe(1) // 排队中未执行
    const c1 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'c' }), 'c1') // 队列满（a2、b1）
    expect(c1).toMatchObject({ isError: true, error: { info: { code: 'BULKHEAD_REJECTED' } } })
    expect(attempts).toBe(1)

    gate.resolve([{ type: 'text', text: 'order-1' }]) // 释放槽位 → 排队调用恢复
    const [rA1, rA2, rB1] = await Promise.all([a1, a2, b1])
    expect(rA1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(rA2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] }) // a2 排队后到达 idempotency → 重放
    expect(rB1).toMatchObject({ isError: false }) // b1 排队后执行
    expect(attempts).toBe(2) // a1 + b1；a2 被重放
  })
})

describe('组合：idempotency（外层，先注册） + bulkhead（内层）', () => {
  it('同 key 先 join（不进入 bulkhead 队列），新 key 才受 bulkhead 约束（排队）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await bulkheadHarness('idempotency-first')
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create_order',
      parameters: {},
      async execute() {
        attempts += 1
        if (attempts === 1) return gate.promise
        return [{ type: 'text', text: `order-${attempts}` }]
      },
    }))

    const a1 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a1')
    await until(() => attempts === 1) // started：占用执行槽（也占用 bulkhead 槽）
    const a2 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'a2') // 同 key → idempotency join（立即，不排队）
    await tick(50)
    expect(attempts).toBe(1) // join 未执行
    const b1 = withinGuard(executeTool(ctx, 'create_order', { orderId: 'b' }), 'b1') // 新 key → bulkhead 排队
    await tick(50)
    expect(attempts).toBe(1) // b1 排队中（受 bulkhead 约束）
    const b2 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'c' }), 'b2') // 队列满 → 拒绝
    expect(b2).toMatchObject({ isError: true, error: { info: { code: 'BULKHEAD_REJECTED' } } })
    expect(attempts).toBe(1)

    gate.resolve([{ type: 'text', text: 'order-1' }])
    const [rA1, rA2, rB1] = await Promise.all([a1, a2, b1])
    expect(rA1).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] })
    expect(rA2).toMatchObject({ content: [{ type: 'text', text: 'order-1' }] }) // join 共享结果
    expect(rB1).toMatchObject({ isError: false }) // b1 排队后执行
    expect(attempts).toBe(2) // a1 + b1；a2 被 join 合并
  })
})
