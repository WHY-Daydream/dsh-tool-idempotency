/**
 * Phase 3 组合测试 · timeout-policy + idempotency（本地 link 宿主）。
 *
 * 场景：提交前/后超时、响应处理阶段失败（joiner 共享失败）、非合作下游。
 *
 * 组合契约（timeout-policy 源码确认）：超时是**合作式预算**——插件在 deadline
 * 到达时中止 exec.signal，要求下游工具转发 signal 才能 quiescence；不合作的
 * body（忽略 signal）会让调用永久挂起。用例显式区分合作/非合作 body。
 * 所有等待加 2s 安全护栏，避免组合缺陷挂起拖死套件。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as Idempotency from '../../src/index.js'
import { executeTool, idempotencyApi, tick, until } from './harness.js'

/** 2s 安全护栏：组合缺陷导致永久挂起时快速失败而不是拖死套件。 */
async function withinGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`GUARD: ${label} hung >2s`)), 2000)),
  ])
}

/** 合作 body：首次调用挂起但转发 exec.signal 的 abort（超时插件可使其 quiescence）。 */
function cooperativeHang(exec: { signal: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (exec.signal.aborted) { reject(new Error('aborted before start')); return }
    exec.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true })
  })
}

async function comboHarness(order: 'timeout-first' | 'idempotency-first'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (order === 'timeout-first') {
    await ctx.plugin(TimeoutPolicy) // 最外层：先注册，超时包住整个调用链（apply(ctx) 无配置）
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] })
  } else {
    await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] }) // 最外层：先注册，同 key 先合并
    await ctx.plugin(TimeoutPolicy)
  }
  return ctx
}

describe('组合：timeout（外层） + idempotency（内层）', () => {
  it('提交前后超时（合作 body，0.2.0 K1 修复实证）：超时错误转 unknown，重试被阻止；release 对账后重新执行', async () => {
    let attempts = 0
    const records: string[] = []
    const ctx = await comboHarness('timeout-first')
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create_order',
      parameters: {},
      timeoutMs: 50,
      async execute(_args, exec) {
        attempts += 1 // 副作用执行点（提交与否无法从调用方区分）
        records.push(`exec-${attempts}`)
        if (attempts === 1) await cooperativeHang(exec) // 挂起直到超时中止
        return [{ type: 'text', text: `order-${attempts}` }]
      },
    }))

    const r1 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'first call')
    expect(r1).toMatchObject({ isError: true }) // 超时错误（无提交证据）
    // 0.2.0：超时（响应丢失）→ unknown → 重试被阻止（K1 修复：不再盲目重执行）
    const r2 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'retry')
    expect(r2).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1) // 未盲目重执行

    idempotencyApi(ctx).release('create_order', { orderId: 'a' }) // 下游对账确认后解除
    const r3 = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'release-retry')
    expect(r3).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 解除后重新执行恰好一次
    expect(records).toEqual(['exec-1', 'exec-2'])
  })

  it('非合作 body：timeout 无法生效，调用挂起（组合契约限制实证：超时是合作式预算）', async () => {
    let attempts = 0
    const ctx = await comboHarness('timeout-first')
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create_order',
      parameters: {},
      timeoutMs: 50,
      async execute() {
        attempts += 1
        if (attempts === 1) await new Promise(() => undefined) // 忽略 signal（非合作）
        return [{ type: 'text', text: 'ok' }]
      },
    }))

    let settled = false
    const call = executeTool(ctx, 'create_order', { orderId: 'a' })
    call.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 300)) // 远超 50ms 超时预算
    console.log('[COMBO-TIMEOUT] 非合作 body：调用在超时预算后未结算 settled=', settled, '（timeout 为合作式预算，需下游转发 signal）')
    expect(settled).toBe(false) // 契约观察：非合作下游导致调用挂起（执行锁被永久占用）
  })
})

describe('组合：idempotency（外层） + timeout（内层）', () => {
  it('owner 超时：joiner 先 join（不重复执行），共享失败转 unknown；release 对账后重试可执行', async () => {
    let attempts = 0
    const ctx = await comboHarness('idempotency-first')
    ctx.tools.register(defineContentToolFixture({
      name: 'create_order',
      description: 'create_order',
      parameters: {},
      timeoutMs: 50,
      async execute(_args, exec) {
        attempts += 1
        if (attempts === 1) await cooperativeHang(exec)
        return [{ type: 'text', text: `order-${attempts}` }]
      },
    }))
    const owner = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'owner')
    await until(() => attempts === 1) // started
    const joiner = withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'joiner') // joined（idempotency 外层优先合并）
    await tick(10)
    const [rOwner, rJoiner] = await Promise.all([owner, joiner])
    expect(rOwner).toMatchObject({ isError: true }) // 超时失败
    expect(rJoiner).toMatchObject({ isError: true }) // joiner 共享 owner 失败，未重复执行
    expect(attempts).toBe(1)

    // 0.2.0：超时（响应丢失）→ unknown → 重试被阻止
    const blocked = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'blocked-retry')
    expect(blocked).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)

    idempotencyApi(ctx).release('create_order', { orderId: 'a' })
    const retry = await withinGuard(executeTool(ctx, 'create_order', { orderId: 'a' }), 'retry')
    expect(retry).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 解除后重新执行
  })
})
