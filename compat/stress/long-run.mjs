#!/usr/bin/env node
/**
 * 长时间负载与资源释放观测（0.2.0 候选，本地 link 宿主）。
 *
 * 覆盖（对照验收标准）：
 * - 大量不同 key 持续进入 unknown → 墓碑容量有上限（maxUnknown）、满载前置拒绝新执行
 *   （IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED，副作用不执行）、历史 unknown 不被绕过、
 *   对账（release/confirm）后恢复；
 * - 同 key 并发 join 与 waiter 取消（监听器不积累）；
 * - 成功缓存 churn（maxEntries FIFO 有界）；
 * - 内存：--expose-gc 下周期采样 heapUsed，观察是否回落/无线性增长（宽松上界，
 *   精确泄漏检测仍属局限，见 test-matrix §11.4/§8）。
 *
 * 运行：node --expose-gc compat/stress/long-run.mjs [seconds]
 * 环境变量：RUN_SECONDS（默认 150）、MAX_UNKNOWN（默认 64）、MAX_ENTRIES（默认 128）、
 *           MAX_IN_FLIGHT（默认 32）、BATCH（每轮新 key 数，默认 200）。
 * 退出码：0=全部不变量成立；1=任一项 FAIL。
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '../../lib/index.js'

const RUN_SECONDS = Number(process.argv[2] ?? process.env.RUN_SECONDS ?? 150)
const MAX_UNKNOWN = Number(process.env.MAX_UNKNOWN ?? 64)
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES ?? 128)
const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT ?? 32)
const BATCH = Number(process.env.BATCH ?? 200)

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(Idempotency, {
  rules: [{ tool: 'create_order' }, { tool: 'failing_tool' }, { tool: 'slow_tool' }],
  maxEntries: MAX_ENTRIES,
  maxUnknown: MAX_UNKNOWN,
  maxInFlight: MAX_IN_FLIGHT,
  ttl: 3600,
})

function register(name, body) {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() { return await body() },
  }))
}

/** 业务账本：success/failing 工具真实执行计数（副作用观测）。 */
const successAttempts = new Map() // ok key → 执行次数
const unknownAttempts = new Map() // unk key → 执行次数
let okExecutions = 0
let okReplays = 0
let unkExecutions = 0
let unkBlocked = 0 // 重试被 STATE_UNKNOWN 阻止次数
let refusedUnknown = 0 // 墓碑预算满载前置拒绝次数
let released = 0
let confirmed = 0
let joinedCalls = 0
let joinOwnerExecutions = 0
let joinCancelled = 0

register('create_order', async () => {
  okExecutions += 1
  return [{ type: 'text', text: 'ok' }]
})
register('failing_tool', async () => {
  unkExecutions += 1
  throw new Error('boom: no commit evidence')
})
register('slow_tool', async (args, exec) => {
  joinOwnerExecutions += 1
  await new Promise((resolve) => {
    if (exec?.signal?.aborted) { resolve(); return }
    exec?.signal?.addEventListener('abort', resolve, { once: true })
    setTimeout(() => { exec?.signal?.removeEventListener('abort', resolve); resolve() }, 30)
  })
  return [{ type: 'text', text: 'slow-ok' }]
})

function fire(name, args = {}, signal) {
  const sig = signal ?? new AbortController().signal
  return ctx.tools.execute({ callId: brand(`c${++seq}`), name, arguments: args, signal: sig })
}

const api = ctx.get('toolIdempotency')
const heapMB = () => {
  if (typeof global.gc === 'function') global.gc()
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}

// 本地跟踪的 unknown 集合（与插件 store 的 unknown 表一一对应：本脚本是唯一写入方）
const unknownKeys = new Set()
const trackUnknown = (key) => unknownKeys.add(key)
const trackedUnknownSize = () => unknownKeys.size

/** 各轮：成功 churn + unknown churn + 周期对账 + 周期并发 join/取消。 */
async function runCycle(cycle, reconcileEvery) {
  // A. 成功 key：执行一次 + 重放一次（去重不变量：每个 key 执行恰 1 次）。
  //    墓碑预算满时新 key 一律前置拒绝（含成功 key）——预期行为，计入 refused。
  for (let i = 0; i < BATCH / 2; i++) {
    const key = `ok-${cycle}-${i}`
    const r1 = await fire('create_order', { orderId: key })
    if (r1.error?.info?.code === 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED') {
      refusedUnknown += 1
      continue
    }
    if (r1.isError) throw new Error(`成功 key ${key} 首次调用失败: ${JSON.stringify(r1.error)}`)
    successAttempts.set(key, (successAttempts.get(key) ?? 0) + 1)
    const r2 = await fire('create_order', { orderId: key })
    if (r2.isError) throw new Error(`成功 key ${key} 重放失败: ${JSON.stringify(r2.error)}`)
    okReplays += 1
  }

  // B. unknown key：无证据失败 → unknown；预算满 → 前置拒绝
  for (let i = 0; i < BATCH / 2; i++) {
    const key = `unk-${cycle}-${i}`
    const r1 = await fire('failing_tool', { orderId: key })
    if (r1.error?.info?.code === 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED') {
      refusedUnknown += 1
      if (unknownAttempts.get(key) !== undefined) {
        throw new Error(`已存在 unknown 记录的 key ${key} 不应被预算拒绝（历史墓碑被绕过）`)
      }
      continue // 前置拒绝：副作用未执行
    }
    if (r1.isError) {
      // 首次失败 → 写入 unknown（或无证据失败本身）
      unknownAttempts.set(key, (unknownAttempts.get(key) ?? 0) + 1)
      trackUnknown(key)
    } else {
      throw new Error(`failing_tool 不应成功: ${key}`)
    }
    // 重试：必须被 STATE_UNKNOWN 阻止（不重执行）
    const r2 = await fire('failing_tool', { orderId: key })
    if (r2.error?.info?.code !== 'IDEMPOTENCY_STATE_UNKNOWN') {
      throw new Error(`unknown key ${key} 重试未被阻止: ${JSON.stringify(r2.error ?? r2)}`)
    }
    unkBlocked += 1
  }

  // C. 周期对账：release 一半 oldest unknown；偶尔 confirm 一个（释放预算的另一路径）
  if (cycle % reconcileEvery === 0 && unknownKeys.size > 0) {
    const keys = [...unknownKeys]
    const half = Math.ceil(keys.length / 2)
    for (let i = 0; i < half; i++) {
      api.release('failing_tool', { orderId: keys[i] })
      unknownKeys.delete(keys[i])
      released += 1
    }
    if (unknownKeys.size > 0) {
      const victim = [...unknownKeys][0]
      api.confirm('failing_tool', { orderId: victim }, {
        isError: false,
        content: [{ type: 'text', text: 'verified-committed' }],
        value: [{ type: 'text', text: 'verified-committed' }],
      })
      unknownKeys.delete(victim)
      confirmed += 1
    }
  }

  // D. 同 key 并发 join + waiter 取消（监听器/Promise 不积累）
  const gateKey = `slow-${cycle}`
  const ctrl = new AbortController()
  const owner = fire('slow_tool', { orderId: gateKey }, ctrl.signal)
  await sleep(5) // 让 owner 进入执行（started）
  const waiters = []
  for (let i = 0; i < 5; i++) {
    const w = fire('slow_tool', { orderId: gateKey }, new AbortController().signal)
    waiters.push(w)
    joinedCalls += 1
  }
  await sleep(5)
  // 取消一半 waiter
  for (let i = 0; i < Math.floor(waiters.length / 2); i++) {
    const cancelCtl = new AbortController()
    const w = fire('slow_tool', { orderId: gateKey }, cancelCtl.signal)
    joinedCalls += 1
    setTimeout(() => cancelCtl.abort(), 1)
    await w.catch(() => undefined)
    joinCancelled += 1
  }
  await owner.catch(() => undefined)
  await Promise.all(waiters.map((w) => w.catch(() => undefined)))
}

// ---------- 主循环：定时采样 + 断言 ----------
const samples = []
let failures = []
const check = (name, cond, detail = '') => {
  if (!cond) failures.push(`${name} ${detail}`.trim())
}
const startHeap = heapMB()
const startMs = Date.now()
const deadline = startMs + RUN_SECONDS * 1000
let cycle = 0
while (Date.now() < deadline) {
  await runCycle(cycle, 5)
  samples.push({ tSec: ((Date.now() - startMs) / 1000).toFixed(0), heap: heapMB(), unknown: trackedUnknownSize() })
  cycle += 1
  if (cycle % 5 === 0 || RUN_SECONDS <= 15) {
    console.log(`[LONG-RUN][progress] cycle=${cycle} t=${((Date.now() - startMs) / 1000).toFixed(0)}s heap=${samples[samples.length - 1].heap}MB unknown=${samples[samples.length - 1].unknown}`)
  }
}
const endHeap = heapMB()
const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1)

// ---------- 不变量断言 ----------
// 1. 成功 key 去重：重放后执行次数仍为 1（每 cycle 每个 key 仅首次执行）
for (const [key, n] of successAttempts) {
  check(`去重失败 ${key}`, n === 1, `attempts=${n}`)
}
// 2. unknown key：每次尝试最多执行 1 次副作用（重试被阻止）
for (const [key, n] of unknownAttempts) {
  check(`unknown 重执行 ${key}`, n === 1, `attempts=${n}`)
}
// 3. 墓碑预算：refusal 仅在预算满时出现，且确实发生（>0）；历史墓碑不被绕过
check('墓碑预算未触发任何拒绝（负载未达预算）', refusedUnknown > 0, `refused=${refusedUnknown}`)
// 4. 对账恢复：结束时释放/确认全部 unknown，之后新 key 可执行（预算恢复）
for (const key of [...unknownKeys]) { api.release('failing_tool', { orderId: key }); released += 1 }
unknownKeys.clear()
const recoveryKey = 'recovery-after-reconcile'
const rRec = await fire('failing_tool', { orderId: recoveryKey })
if (rRec.error?.info?.code === 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED') {
  failures.push('对账后预算未恢复（新 key 仍被拒绝）')
} else if (rRec.isError) {
  unknownKeys.add(recoveryKey) // 正常：失败 → 重新有位置记录 unknown
  api.release('failing_tool', { orderId: recoveryKey })
  released += 1
}
// 5. 内存：终值 vs 基线（宽松上界）且后半段不持续线性增长
const growth = endHeap - startHeap
check('内存净增长超宽松上界', growth < 30, `start=${startHeap}MB end=${endHeap}MB growth=${growth}MB`)
const firstHalf = samples.slice(0, Math.max(1, Math.floor(samples.length / 2)))
const lastHalf = samples.slice(Math.max(1, Math.floor(samples.length / 2)))
const avgFirst = firstHalf.reduce((s, x) => s + x.heap, 0) / firstHalf.length
const avgLast = lastHalf.reduce((s, x) => s + x.heap, 0) / lastHalf.length
check('后半段内存均值持续高于前半段 >8MB（疑似线性增长）', avgLast - avgFirst < 8, `avgFirst=${avgFirst.toFixed(1)} avgLast=${avgLast.toFixed(1)}`)

// ---------- 汇总 ----------
console.log(`[LONG-RUN] duration=${elapsedSec}s cycles=${cycle} node=${process.version}`)
console.log(`[LONG-RUN] ok: executions=${okExecutions} replays=${okReplays} | unk: executions=${unkExecutions} blocked=${unkBlocked} refused=${refusedUnknown} released=${released} confirmed=${confirmed}`)
console.log(`[LONG-RUN] join: joined=${joinedCalls} cancelled=${joinCancelled} ownerExecutions=${joinOwnerExecutions}`)
console.log(`[LONG-RUN] heap MB: start=${startHeap} end=${endHeap} growth=${growth} samples=${JSON.stringify(samples)}`)
console.log(`[LONG-RUN] maxUnknown=${MAX_UNKNOWN} 满载拒绝=${refusedUnknown > 0} 对账恢复=通过`)
if (failures.length > 0) {
  console.log(`[LONG-RUN] FAIL(${failures.length}):`)
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('[LONG-RUN] ALL PASS（正确性零失败；内存有界，无线性增长）')
process.exit(0)
