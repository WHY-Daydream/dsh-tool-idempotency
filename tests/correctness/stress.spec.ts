/**
 * Phase 4 压力 / 内存 / 长期运行测试（确定性能基线）。
 *
 * 原则：
 * - 正确性必须零失败（并发断言全部使用 started/joined/committed 屏障，不依赖 sleep）。
 * - 性能/内存阈值按「相对基线 + 宽松上界」记录为证据，不预设具体毫秒数
 *   （基线在本机实时测量，无插件 vs 插件对比）。
 * - 内存用 process.memoryUsage() 采样；v8 GC 非确定性，断言用宽松上界并如实打印曲线，
 *   精确泄漏检测需 --expose-gc（记录为局限）。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { deferred, executeTool, registerTool, tick, toolHarness, until } from './harness.js'

describe('压力：同 key 大量并发', () => {
  it('500 并发同 key：副作用恰一次，全部 waiter 结算且结果一致', { timeout: 30000 }, async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const calls = Array.from({ length: 500 }, () => executeTool(ctx, 'create_order', { orderId: 'a' }))
    await until(() => attempts === 1) // started 屏障：仅一次真实执行
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed
    const results = await Promise.all(calls)
    expect(attempts).toBe(1) // 副作用始终一次
    for (const r of results) {
      expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    }
  })
})

describe('压力：不同 key 大量并发（maxInFlight）', () => {
  it('200 并发（maxInFlight=16）：恰 16 次执行、其余容量拒绝，槽释放后恢复', { timeout: 30000 }, async () => {
    const N = 200
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 16 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const calls = Array.from({ length: N }, (_, i) => executeTool(ctx, 'create_order', { orderId: `k${i}` }))
    await until(() => attempts === 16) // started 屏障：16 个执行槽全占
    gate.resolve([{ type: 'text', text: 'order-1' }]) // committed：先释放 owner，避免 Promise.all 等待 owner 的死锁
    const settled = await Promise.all(calls.map((c) => c.then(
      (r) => ({ isError: (r as { isError?: boolean }).isError === true, code: (r as { error?: { info?: { code?: string } } })?.error?.info?.code }),
    )))
    const executed = settled.filter((s) => !s.isError).length
    const rejected = settled.filter((s) => s.code === 'IDEMPOTENCY_CAPACITY_REJECTED').length
    console.log(`[STRESS] 200 并发 maxInFlight=16：executed=${executed} capacity-rejected=${rejected}`)
    expect(executed).toBe(16)
    expect(rejected).toBe(N - 16) // 其余全部容量拒绝（reserve 同步裁定，无并发漏网）
    expect(attempts).toBe(16)

    gate.resolve([{ type: 'text', text: 'order-1' }])
    await Promise.all(calls) // 全部结算
    const after = await executeTool(ctx, 'create_order', { orderId: 'recover' })
    expect(after).toMatchObject({ isError: false }) // 恢复：新 key 可执行
    expect(attempts).toBe(17)
  })
})

describe('压力：混合负载（重复 + 新请求）与基线对比', () => {
  it('吞吐/延迟相对统计：无插件基线 vs 插件（100 执行 + 100 重放）', { timeout: 60000 }, async () => {
    // 无插件基线
    const baseCtx = new Context()
    await baseCtx.plugin(SystemPrompt)
    await baseCtx.plugin(ToolRuntime)
    registerTool(baseCtx, 'create_order', async () => [{ type: 'text', text: 'ok' }])
    const t0 = performance.now()
    for (let i = 0; i < 200; i += 1) await executeTool(baseCtx, 'create_order', { orderId: `k${i}` })
    const baseMs = performance.now() - t0

    // 插件：100 新 key 各执行一次 + 100 重复各重放一次
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const t1 = performance.now()
    for (let i = 0; i < 100; i += 1) {
      await executeTool(ctx, 'create_order', { orderId: `k${i}` })
      await executeTool(ctx, 'create_order', { orderId: `k${i}` }) // 重复 → 重放
    }
    const plugMs = performance.now() - t1
    console.log(
      `[STRESS] 基线(200 独立) ${baseMs.toFixed(1)}ms | 插件(100 执行+100 重放) ${plugMs.toFixed(1)}ms | 真实执行=${attempts}`,
    )
    expect(attempts).toBe(100) // 每个重复都被去重（命中率 50%）
  })
})

describe('压力：大量 waiter 加入后取消', () => {
  it('5 轮 × 50 waiter 取消：全部干净退出、owner 正常结算、内存无持续积累（宽松上界）', { timeout: 60000 }, async () => {
    let attempts = 0
    const gates: { promise: Promise<ContentBlock[]>; resolve: (v: ContentBlock[]) => void }[] = []
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gates[gates.length - 1]!.promise
    })
    const before = process.memoryUsage().heapUsed
    for (let round = 0; round < 5; round += 1) {
      const gate = deferred<ContentBlock[]>()
      gates.push(gate)
      const owner = executeTool(ctx, 'create_order', { orderId: `r${round}` })
      await until(() => attempts === round + 1) // started
      const waiterCtrls = Array.from({ length: 50 }, () => new AbortController())
      const waiters = waiterCtrls.map((c) => executeTool(ctx, 'create_order', { orderId: `r${round}` }, c.signal))
      await tick(20) // joined
      for (const c of waiterCtrls) c.abort() // 全部取消
      await Promise.all(waiters.map((w) => w.then(() => undefined, () => undefined))) // 全部退出（不挂起）
      gate.resolve([{ type: 'text', text: 'ok' }]) // committed
      await owner
      expect(attempts).toBe(round + 1) // waiter 取消不影响 owner，无重复执行
    }
    const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024
    console.log(`[STRESS] 5 轮 × 50 waiter 取消：heap 净增长 ${growthMb.toFixed(1)}MB`)
    expect(growthMb).toBeLessThan(128) // 宽松上界：无每轮数量级积累（精确泄漏检测需 --expose-gc，见文件头说明）
  })
})

describe('压力：长期未完成 owner', () => {
  it('容量长期耗尽：新 key 持续被拒且诊断含 maxInFlight，owner 完成即恢复', { timeout: 30000 }, async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1) // started：唯一执行槽被长期占用
    for (let i = 0; i < 5; i += 1) {
      const r = await executeTool(ctx, 'create_order', { orderId: `b${i}` })
      expect(r).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_CAPACITY_REJECTED' } } })
      expect(JSON.stringify(r)).toContain('maxInFlight 1') // 诊断信息充分（含配置值）
    }
    gate.resolve([{ type: 'text', text: 'order-1' }]) // owner 最终完成
    await owner
    const after = await executeTool(ctx, 'create_order', { orderId: 'b5' })
    expect(after).toMatchObject({ isError: false }) // 容量恢复
    expect(attempts).toBe(2)
  })
})

describe('压力：持续运行周期清空', () => {
  it('8 轮 × 200 新 key churn：缓存有界（FIFO 1024）下内存不线性增长（相对采样）', { timeout: 120000 }, async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 3600, maxEntries: 1024 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: 'ok' }]
    })
    const samples: number[] = []
    for (let round = 0; round < 8; round += 1) {
      for (let i = 0; i < 200; i += 1) await executeTool(ctx, 'create_order', { orderId: `r${round}k${i}` })
      samples.push(process.memoryUsage().heapUsed / 1024 / 1024)
    }
    // 跳过前两轮预热，比较后续采样：1600 个 key 总量远超缓存上限（1024），FIFO 淘汰后应收敛
    const first = samples[2]!
    const last = samples[samples.length - 1]!
    console.log(`[STRESS] heap MB 采样（8 轮）: ${samples.map((s) => s.toFixed(0)).join(',')}`)
    expect(last - first).toBeLessThan(64) // 宽松上界：不应随轮次线性增长
  })
})
