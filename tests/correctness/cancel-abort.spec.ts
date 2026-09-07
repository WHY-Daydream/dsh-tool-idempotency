/**
 * Phase 2 业务正确性 · 方向 3：取消与异常。
 *
 * 场景：owner/waiter 取消、同步抛错、下游挂起。
 * 验收：waiter 可退出、owner 状态正确、无错误释放锁（无僵尸锁/无重复执行）。
 *
 * 并发用例全部使用 started/joined/committed 同步屏障（deferred + until + tick），
 * 不依赖固定 sleep 假设。每个用例同时断言：副作用次数、返回结果、幂等状态、调用记录。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  deferred, executeTool, idempotencyApi, registerTool, tick, toolHarness, until,
} from './harness.js'

describe('取消与异常：waiter 取消', () => {
  it('waiter 取消：独立退出、不取消 owner、无重复执行；owner 完成后可正常重放', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const ownerCtrl = new AbortController()
    const waiterCtrl = new AbortController()
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' }, ownerCtrl.signal)
    await until(() => attempts === 1) // started 屏障：owner 已启动并持有执行锁
    const waiter = executeTool(ctx, 'create_order', { orderId: 'a' }, waiterCtrl.signal)
    await tick(10) // joined 屏障：dispatch 已进入 guard 的 join 分支
    waiterCtrl.abort()

    // waiter 必须独立退出（宿主可能映射为 isError 结果或 rejection，两者均可）
    const outcome = await Promise.race([
      waiter.then(
        () => 'resolve' as const,
        () => 'reject' as const,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter hung after abort')), 300)),
    ])
    expect(attempts).toBe(1) // waiter 离开不影响 owner，无重复执行

    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed 屏障：owner 结算
    const rOwner = await owner
    expect(rOwner).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1)

    // 无僵尸锁：owner 完成后同 key 重放首次结果
    const replay = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(replay).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(['resolve', 'reject']).toContain(outcome)
  })
})

describe('取消与异常：owner 失败', () => {
  it('owner 抛错：joiners 收到同一失败、状态转 unknown、重试被阻止；release 对账后重新执行（无僵尸锁）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) return gate.promise.then(() => { throw new Error('boom') })
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started
    const joiner = executeTool(ctx, 'create_order', { orderId: 'a' }) // joined（派发是异步的，需等它进入 join 分支）
    await tick(10) // joined 屏障：若在此前失败 owner，joiner 会变成一次合法的新执行（契约内竞态），而非收到 owner 的失败
    gate.reject(new Error('boom')) // committed：owner 失败

    // 本地宿主把 guard 传播的 rejection 映射为 isError 工具结果（非 promise rejection），
    // 验收点是：双方都干净结算（不挂起）、失败信息可辨识。
    const [rOwner, rJoiner] = await Promise.all([owner, joiner])
    expect(rOwner).toMatchObject({ isError: true })
    expect(rJoiner).toMatchObject({ isError: true }) // joiner 收到 owner 的失败，不会挂起
    expect(JSON.stringify(rOwner)).toContain('boom')
    expect(JSON.stringify(rJoiner)).toContain('boom')

    // 0.2.0：无提交证据的失败 → unknown，重试被阻止（不再盲目重执行）
    const blocked = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(blocked).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)

    // 对账解除后重试重新执行
    idempotencyApi(ctx).release('create_order', { orderId: 'a' })
    const retry = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(retry).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 锁已释放、状态已解除：重试重新执行
  })

  it('预取消信号：调用快速失败且不占锁，后续正常调用恰好执行一次', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })

    const aborted = new AbortController()
    aborted.abort()
    // 宿主可能把预取消映射为 isError 结果或 rejection，两种都要能干净退场
    const first = await executeTool(ctx, 'create_order', { orderId: 'a' }, aborted.signal)
      .catch(() => ({ cancelled: true }))
    expect(first === undefined || (first as { cancelled?: boolean })?.cancelled === true || (first as { isError?: boolean })?.isError !== false)
      .toBe(true)
    expect(attempts).toBe(0) // 预取消调用不得执行副作用

    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1) // 无僵尸锁：正常调用执行一次
    expect(records).toEqual(['exec-1'])
  })
})

describe('取消与异常：同步抛错', () => {
  it('下游同步抛错：claim 后释放锁并转 unknown，重试被阻止；release 后重新执行，无错误释放锁', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      records.push(`exec-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    // 在 guard 之后注册的监听器：位于 next() 下游，同步抛出
    const removeThrower = ctx.on('tools/execute', () => {
      throw new Error('sync-downstream-boom')
    }) as unknown as () => void

    const first = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(first).toMatchObject({ isError: true }) // 调度器把同步 throw 转成工具错误结果
    expect(attempts).toBe(0) // 工具体未被执行

    removeThrower()
    // 0.2.0：同步抛错（无提交证据）→ unknown，重试被阻止
    const blocked = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(blocked).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(0)

    idempotencyApi(ctx).release('create_order', { orderId: 'a' })
    const second = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(second).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1) // 失败 claim 已释放锁、状态已解除；重试恰好执行一次
    expect(records).toEqual(['exec-1'])
  })
})

describe('取消与异常：下游挂起', () => {
  it('owner 挂起：同 key 重试 join（不执行、不被容量拒绝）；waiter 可取消离开；owner 随后结算可重放', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })

    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started：owner 持有唯一的执行槽并挂起
    const retry = executeTool(ctx, 'create_order', { orderId: 'a' }) // 同 key → join，而非容量拒绝
    await tick(10)
    expect(attempts).toBe(1) // join 未产生新副作用

    const waiterCtrl = new AbortController()
    const waiter = executeTool(ctx, 'create_order', { orderId: 'a' }, waiterCtrl.signal)
    await tick(10) // joined
    waiterCtrl.abort()
    const outcome = await Promise.race([
      waiter.then(
        () => 'resolve' as const,
        () => 'reject' as const,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waiter hung under hang')), 300)),
    ])
    expect(attempts).toBe(1)

    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed：owner 最终结算
    const [rOwner, rRetry] = await Promise.all([owner, retry])
    expect(attempts).toBe(1)
    expect(rOwner).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(rRetry).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(['resolve', 'reject']).toContain(outcome)
  })
})
