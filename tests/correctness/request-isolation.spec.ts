/**
 * Phase 2 业务正确性 · 方向 1：请求隔离。
 *
 * 场景：相同 key 跨工具、跨 Agent/session/工作区（=独立 Context）、跨调用方。
 * 验收：按声明的作用域隔离，不串用结果。
 *
 * 0.1.3 声明的作用域（源码契约）：
 * - key 空间分离：`explicit:<keyArg值>` 与 `fp:<指纹>`（指纹 = 工具名 + 规范化参数）。
 * - 插件实例（Context）级隔离：不同 Context 各自独立的 MemoryStore。
 * - 每个用例同时断言：实际副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  deferred, executeTool, registerTool, tick, toolHarness, until,
} from './harness.js'

describe('请求隔离：同 key 跨工具', () => {
  it('不同工具共用 explicit keyArg 值时 fail-loud（KEY_MISMATCH），不串用结果、不执行新副作用', async () => {
    const calls: string[] = []
    let attemptsA = 0
    let attemptsB = 0
    const ctx = await toolHarness({
      rules: [
        { tool: 'create_order', keyArg: 'requestId' },
        { tool: 'ship_order', keyArg: 'requestId' },
      ],
    })
    registerTool(ctx, 'create_order', async () => {
      attemptsA += 1
      calls.push('create_order')
      return [{ type: 'text', text: 'created-1' }]
    })
    registerTool(ctx, 'ship_order', async () => {
      attemptsB += 1
      calls.push('ship_order')
      return [{ type: 'text', text: 'shipped-1' }]
    })

    const r1 = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'created-1' }] })

    // 同 explicit key（r1）但不同工具：指纹含工具名 → 冲突被拒绝，而不是执行或重放。
    const r2 = await executeTool(ctx, 'ship_order', { requestId: 'r1', orderId: 'a' })
    expect(attemptsA).toBe(1)
    expect(attemptsB).toBe(0)
    expect(r2).toMatchObject({
      isError: true,
      error: { info: { code: 'IDEMPOTENCY_KEY_MISMATCH', name: 'IdempotencyKeyMismatch' } },
    })
    expect(calls).toEqual(['create_order']) // 调用记录证明 ship_order 未被真实执行
  })

  it('无 keyArg（指纹键）时不同工具天然隔离，各自执行一次且结果不串用', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }, { tool: 'ship_order' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('create_order')
      return [{ type: 'text', text: 'created-1' }]
    })
    registerTool(ctx, 'ship_order', async () => {
      records.push('ship_order')
      return [{ type: 'text', text: 'shipped-1' }]
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r2 = await executeTool(ctx, 'ship_order', { orderId: 'a' }) // 参数相同，但工具名不同
    expect(records).toEqual(['create_order', 'ship_order'])
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'created-1' }] })
    expect(r2).toMatchObject({ content: [{ type: 'text', text: 'shipped-1' }] }) // 无串用
  })

  it('同 key 同工具、不同调用方（callId）→ 去重重放，副作用仅一次', async () => {
    const records: string[] = []
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`call-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const r1 = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    const r2 = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    expect(attempts).toBe(1) // 幂等状态：succeeded → 重放
    expect(records).toEqual(['call-1']) // 调用记录只有一次真实执行
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })

  it('不同 key（不同 requestId 值）互不干扰，各自执行', async () => {
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      records.push('exec')
      return [{ type: 'text', text: 'order' }]
    })
    await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    await executeTool(ctx, 'create_order', { requestId: 'r2', orderId: 'b' })
    expect(records).toEqual(['exec', 'exec'])
  })

  it('explicit key 与 fingerprint 键空间分离：同参数有无 keyArg 不碰撞', async () => {
    const records: string[] = []
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' }) // key=explicit:r1
    // 缺 keyArg → 回退指纹键 fp:...（参数相同但键空间不同，不得与 explicit:r1 碰撞/串用）
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    const r3 = await executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' }) // explicit:r1 → 重放 r1
    expect(records).toEqual(['exec-1', 'exec-2']) // r2 落入 fp 空间独立执行；r3 在 explicit 空间内被去重
    expect(r1).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] }) // 独立执行，未重放 r1
    expect(r3).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] }) // explicit 空间内重放首次结果
  })
})

describe('请求隔离：跨 Context（Agent / session / 工作区）', () => {
  it('两个独立 Context 同 key 各自执行一次，各自作用域内去重，互不影响', async () => {
    const ctxA = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    const ctxB = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    const recordsA: string[] = []
    const recordsB: string[] = []
    registerTool(ctxA, 'create_order', async () => {
      recordsA.push('exec')
      return [{ type: 'text', text: 'a-1' }]
    })
    registerTool(ctxB, 'create_order', async () => {
      recordsB.push('exec')
      return [{ type: 'text', text: 'b-1' }]
    })

    await executeTool(ctxA, 'create_order', { requestId: 'r1', orderId: 'a' })
    await executeTool(ctxB, 'create_order', { requestId: 'r1', orderId: 'a' }) // 同 key，跨 Context
    expect(recordsA).toEqual(['exec'])
    expect(recordsB).toEqual(['exec']) // 隔离生效：各执行一次

    // 各自作用域内重放，不跨 Context 串用结果
    const rA2 = await executeTool(ctxA, 'create_order', { requestId: 'r1', orderId: 'a' })
    const rB2 = await executeTool(ctxB, 'create_order', { requestId: 'r1', orderId: 'a' })
    expect(recordsA).toEqual(['exec'])
    expect(recordsB).toEqual(['exec'])
    expect(rA2).toMatchObject({ content: [{ type: 'text', text: 'a-1' }] })
    expect(rB2).toMatchObject({ content: [{ type: 'text', text: 'b-1' }] })
  })

  it('同 Context 内并发（started/joined 屏障）：join 不产生新副作用，返回同一结果', async () => {
    let attempts = 0
    const records: string[] = []
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return gate.promise
    })

    const owner = executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    await until(() => attempts === 1) // started 屏障：owner 已启动并持有执行锁
    const joiner = executeTool(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
    await tick(10) // joined 屏障：给 dispatch 进入 join 分支的机会
    expect(attempts).toBe(1) // joiner 未重新执行副作用

    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed 屏障：owner 结算
    const [rOwner, rJoiner] = await Promise.all([owner, joiner])
    expect(attempts).toBe(1)
    expect(records).toEqual(['exec-1'])
    expect(rOwner).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(rJoiner).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
  })
})
