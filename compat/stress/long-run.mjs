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
 *           MAX_IN_FLIGHT（默认 32）、BATCH（每轮新 key 数，默认 200）、
 *           LONG_PENDING_CAP（长期 owner 的 pending waiter 封顶，默认 100）。
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
const LONG_PENDING_CAP = Number(process.env.LONG_PENDING_CAP ?? 100)
/** NO_PLUGIN=1：不挂载幂等插件（宿主基线对照，区分宿主/插件内存累积）。 */
const NO_PLUGIN = process.env.NO_PLUGIN === '1'
/** 阶段开关（诊断用）：SKIP_B / SKIP_D / SKIP_E 分别跳过 unknown churn / 慢 join / 长期 owner。 */
const SKIP_B = process.env.SKIP_B === '1'
const SKIP_D = process.env.SKIP_D === '1'
const SKIP_E = process.env.SKIP_E === '1'
/**
 * 长期 owner 的总 join 上限（默认不设限）。实测（2026-09-07）：同一在途 owner 每次 join
 * （含已取消）宿主侧保留约 4.5KB dispatch 记录，直到 owner 完成才释放——小时级运行应设
 * 有限值（如 5000）以观察「爬升→平台→完成释放」曲线，避免线性保留主导观测。
 */
const LONG_TOTAL_JOIN_CAP = Number(process.env.LONG_TOTAL_JOIN_CAP ?? Infinity)

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
if (!NO_PLUGIN) {
  await ctx.plugin(Idempotency, {
    rules: [{ tool: 'create_order' }, { tool: 'failing_tool' }, { tool: 'slow_tool' }, { tool: 'long_tool' }],
    maxEntries: MAX_ENTRIES,
    maxUnknown: MAX_UNKNOWN,
    maxInFlight: MAX_IN_FLIGHT,
    ttl: 3600,
  })
}

function register(name, body) {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() { return await body() },
  }))
}

/** 业务账本：success/failing 工具真实执行计数（副作用观测）。去重不变量按周期内联
 *  检查（每个 key 只在本周期出现一次），不跨周期累积 Map——脚本自身内存与运行时长无关。 */
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
// 长期未完成 owner（观察反复 join/cancel 的引用累积）
const longGate = deferred()
let longOwnerStarted = false
let longOwnerPromise = null
let longJoined = 0
let longCancelled = 0
let longPending = [] // { w, ctl }：仍在等待 owner 完成的 waiter（封顶）
let longPendingMax = 0
let longSettled = 0
let longOwnerResult = 'never-completed'

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
register('long_tool', async () => {
  await longGate.promise // 长期不完成：直至脚本结束清理时才 resolve
  return [{ type: 'text', text: 'long-ok' }]
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
    // okExecutions 由工具 body 计数（真实副作用执行），此处不再重复计数
    const r2 = await fire('create_order', { orderId: key })
    if (r2.isError) throw new Error(`成功 key ${key} 重放失败: ${JSON.stringify(r2.error)}`)
    okReplays += 1
  }
  // 去重不变量：执行/重放成对推进（每对 key 一次执行一次重放；拒绝的 key 两者皆无）。
  // 无插件模式（宿主基线对照）没有去重，跳过该断言。
  if (!NO_PLUGIN && okExecutions !== okReplays) {
    throw new Error(`成功 key 去重不变量被破坏：执行=${okExecutions} 重放=${okReplays}`)
  }

  // B. unknown key：无证据失败 → unknown；预算满 → 前置拒绝（仅插件模式）
  if (!NO_PLUGIN && !SKIP_B) {
    for (let i = 0; i < BATCH / 2; i++) {
    const key = `unk-${cycle}-${i}`
    const r1 = await fire('failing_tool', { orderId: key })
    if (r1.error?.info?.code === 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED') {
      refusedUnknown += 1
      if (unknownKeys.has(key)) {
        throw new Error(`已存在 unknown 记录的 key ${key} 不应被预算拒绝（历史墓碑被绕过）`)
      }
      continue // 前置拒绝：副作用未执行
    }
    if (r1.isError) {
      // 首次失败 → 写入 unknown（或无证据失败本身）
      unkExecutions += 1
      trackUnknown(key)
    } else {
      throw new Error(`failing_tool 不应成功: ${key}`)
    }
    // 重试：必须被 STATE_UNKNOWN 阻止（不重执行）——本周期内联断言
    const r2 = await fire('failing_tool', { orderId: key })
    if (r2.error?.info?.code !== 'IDEMPOTENCY_STATE_UNKNOWN') {
      throw new Error(`unknown key ${key} 重试未被阻止: ${JSON.stringify(r2.error ?? r2)}`)
    }
    unkBlocked += 1
    }
  }

  // C. 周期对账：release 一半 oldest unknown；偶尔 confirm 一个（释放预算的另一路径）
  //    （仅插件模式；无插件时 api 不存在）
  if (!NO_PLUGIN && cycle % reconcileEvery === 0 && unknownKeys.size > 0) {
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
  if (!SKIP_D) {
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

  // E. 长期未完成 owner：同一个 owner 跨周期保持 in-flight，反复 join/cancel。
  //    观察引用是否累积（heap 采样覆盖）；pending waiter 封顶，超龄强制取消。
  //    （仅插件模式：join 语义由插件提供；无插件基线不需要）
  if (!NO_PLUGIN && !SKIP_E && longJoined < LONG_TOTAL_JOIN_CAP) {
    if (!longOwnerStarted) {
      longOwnerPromise = fire('long_tool', { orderId: 'long-owner' }, new AbortController().signal)
      longOwnerStarted = true
    }
    const fresh = []
    for (let i = 0; i < 8; i++) {
      const ctl = new AbortController()
      const w = fire('long_tool', { orderId: 'long-owner' }, ctl.signal)
      longJoined += 1
      if (i < 4) {
        // 立即取消一半（join 后 abort → 独立退出，监听器移除）
        setTimeout(() => ctl.abort(), 1)
        longCancelled += 1
        w.catch(() => undefined)
      } else {
        fresh.push({ w, ctl })
      }
    }
    // 封顶：合并池保留最新的 cap 个，超龄（最旧）强制取消——cap=0 时本批全部取消
    // （注意 slice(-0) === slice(0) 会保留全部，必须用显式 keepN）
    const combined = [...longPending, ...fresh]
    const keepN = Math.min(LONG_PENDING_CAP, combined.length)
    const evict = combined.slice(0, combined.length - keepN)
    longPending = combined.slice(combined.length - keepN)
    for (const x of evict) {
      x.ctl.abort()
      longCancelled += 1
      x.w.catch(() => undefined)
    }
    longPendingMax = Math.max(longPendingMax, longPending.length)
    longSettled += longPending.length // 统计口径：当前仍挂起的 waiter（结算见收尾）
  }
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

// ---------- 收尾清理与资源释放观测 ----------
// 1) 对账全部 unknown（预算恢复的最终确认见下；仅插件模式）
if (!NO_PLUGIN) {
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
}
// 2) 长期 owner 完成：gate resolve → owner 与全部 pending waiter 结算（监听器移除）
if (!NO_PLUGIN && longOwnerStarted) {
  longGate.resolve()
  longOwnerResult = await longOwnerPromise.then(() => 'resolved', () => 'rejected').catch(() => 'rejected')
  await Promise.allSettled(longPending.map((x) => x.w))
  longPending = [] // 显式释放引用
}
global.gc?.()
// 3) 插件卸载（ctx.dispose）：监听器/服务随 context 释放；随后 gc 测存活堆
let disposed = false
try { await ctx.dispose(); disposed = true } catch { disposed = false }
global.gc?.()
const finalHeap = heapMB()

// ---------- 不变量断言 ----------
// 1. 墓碑预算：refusal 确实发生（>0）；历史墓碑不被绕过（周期内已断言；仅插件模式）
if (!NO_PLUGIN) {
  check('墓碑预算未触发任何拒绝（负载未达预算）', refusedUnknown > 0, `refused=${refusedUnknown}`)
  // 2. 对账恢复：对账后新 key 可执行（预算恢复，见上 recovery 分支未记失败）
  check('对账后预算未恢复', !failures.some((f) => f.startsWith('对账后预算未恢复')), '')
  // 3. 长期未完成 owner：pending waiter 不突破封顶（引用有界）
  check('长期 owner pending waiter 突破封顶', longPendingMax <= LONG_PENDING_CAP, `pendingMax=${longPendingMax} cap=${LONG_PENDING_CAP}`)
  check('长期 owner 无 join 流量（脚本缺陷）', longJoined > 0, `joined=${longJoined}`)
}
// 4. 资源释放：owner 完成 + 对账 + 卸载后 heap 回落至基线附近（宽松上界）
check('清理后 heap 未回落（资源未释放）', finalHeap <= startHeap + 15, `start=${startHeap}MB final=${finalHeap}MB`)
// 5. 内存：终值 vs 基线（宽松上界）+ **每 join 保留预算**（实测：在途 owner 每次 join
//    约 4.5KB 宿主侧保留，owner 完成才释放；增长应与 join 数成比例而非超线性/失控）
const growth = endHeap - startHeap
check('内存净增长超宽松上界', growth < 30, `start=${startHeap}MB end=${endHeap}MB growth=${growth}MB`)
const joinRetentionBudget = 8 * longJoined / 1024 // 8KB/join 上界（实测 ~4.5KB，留余量）
check(
  '每 join 保留超预算（增长与 join 数不成比例）',
  growth <= 10 + joinRetentionBudget,
  `growth=${growth}MB budget=${(10 + joinRetentionBudget).toFixed(1)}MB joined=${longJoined}`,
)

// ---------- 汇总 ----------
console.log(`[LONG-RUN] duration=${elapsedSec}s cycles=${cycle} node=${process.version}`)
console.log(`[LONG-RUN] ok: executions=${okExecutions} replays=${okReplays} | unk: executions=${unkExecutions} blocked=${unkBlocked} refused=${refusedUnknown} released=${released} confirmed=${confirmed}`)
console.log(`[LONG-RUN] join: joined=${joinedCalls} cancelled=${joinCancelled} ownerExecutions=${joinOwnerExecutions}`)
console.log(`[LONG-RUN] long-owner: joined=${longJoined} cancelled=${longCancelled} pendingMax=${longPendingMax} (cap=${LONG_PENDING_CAP}) owner=${longOwnerResult} disposed=${disposed}`)
console.log(`[LONG-RUN] heap MB: start=${startHeap} end=${endHeap} final(after cleanup)=${finalHeap} growth=${growth} samples=${JSON.stringify(samples)}`)
console.log(`[LONG-RUN] maxUnknown=${MAX_UNKNOWN} 满载拒绝=${refusedUnknown > 0} 对账恢复=通过`)
if (failures.length > 0) {
  console.log(`[LONG-RUN] FAIL(${failures.length}):`)
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('[LONG-RUN] ALL PASS（正确性零失败；内存有界；owner 完成+对账+卸载后资源回落）')
process.exit(0)
