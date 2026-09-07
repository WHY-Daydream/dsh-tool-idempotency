/**
 * C3 场景（registry 0.1.2-rc.1 闭包，仅公开 API）：
 *  1) 结构化结果重放（不同 callId、内容逐字一致、副作用一次）
 *  2) waiter 取消：join 中的 waiter 被 abort 不取消 owner，owner 结果正常落缓存
 *  3) owner 取消：owner 自身 abort（提交后）不产生重复副作用/不挂起
 *  4) 超时/取消前后等价复现（提交前 vs 提交后 abort）
 *  5) Saga 补偿后缓存处理：补偿后同 key 重放旧结果的已知缺口复现
 * 逐项打印实际观察，PASS/FAIL 以副作用账本与不变量为准。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '@why-daydream/dsh-tool-idempotency'

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Idempotency, config)
  return ctx
}
function register(ctx, name, body) {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      return await body()
    },
  }))
}
function fire(ctx, name, args = {}, signal) {
  const sig = signal ?? new AbortController().signal // registry dispatcher 要求 caller signal 存在
  return ctx.tools.execute({ callId: brand(`c${++seq}`), name, arguments: args, signal: sig })
}
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const results = []
async function scenario(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`FAIL ${name}\n  ${err.message}`)
  }
}

// ---------- 1. 结构化结果重放 ----------
await scenario('结构化结果重放：不同 callId 得到逐字一致内容，副作用一次', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: `order o1 created (#${attempts})` }] })
  const s1 = new AbortController().signal
  const s2 = new AbortController().signal
  const r1 = await fire(ctx, 'create_order', { orderId: 'o1' }, s1)
  const r2 = await fire(ctx, 'create_order', { orderId: 'o1' }, s2) // 不同 callId + 不同 signal
  assert.equal(attempts, 1)
  assert.equal(r1.isError, false)
  assert.equal(r2.isError, false)
  assert.deepEqual(r1.content, r2.content)
  assert.equal(r2.content[0].text, 'order o1 created (#1)') // 重放的是首次结果
})

// ---------- 2. waiter 取消 ----------
await scenario('waiter 取消：join 中的 waiter 被 abort，不取消 owner，缓存正常', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const ownerCtrl = new AbortController()
  const waiterCtrl = new AbortController()
  const owner = fire(ctx, 'create_order', { orderId: 'o1' }, ownerCtrl.signal) // owner
  const waiter = fire(ctx, 'create_order', { orderId: 'o1' }, waiterCtrl.signal) // join
  waiterCtrl.abort() // waiter 离开
  const waiterResult = await waiter // 必须正常结束（aborted/cancelled 形态），不永久挂起
  assert.equal(attempts, 1) // owner 未被取消、未重复执行
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const ownerResult = await owner
  assert.equal(ownerResult.isError, false)
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(replay.isError, false)
  assert.equal(replay.content[0].text, 'order-1')
  assert.equal(attempts, 1)
  console.log(`  waiter 观察：waiterResult.isError=${waiterResult.isError}`)
})

// ---------- 3. owner 取消（提交后）不重复、不挂起 ----------
await scenario('owner 取消：owner 自身 abort 后无僵尸锁、无重复副作用', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const ownerCtrl = new AbortController()
  const owner = fire(ctx, 'create_order', { orderId: 'o1' }, ownerCtrl.signal)
  ownerCtrl.abort() // owner 取消（工具仍在执行）
  const joiner = fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal) // 同 key join
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [rOwner, rJoin] = await Promise.all([owner, joiner]) // 都必须结束
  assert.equal(attempts, 1)
  console.log(`  owner 观察：rOwner.isError=${rOwner.isError}（abort 后形态由 registry 决定），joiner=${rJoin.isError}`)
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  console.log(`  owner 取消后重放：isError=${replay.isError} content=${JSON.stringify(replay.content)}`)
})

// ---------- 4. 提交前 vs 提交后 abort（= 超时/取消前后等价面） ----------
// 协作语义：registry「取消不抛弃已启动的 body」，工具必须主动监听 exec.signal
//（与官方 dsh-tool-call-timeout-policy 的协作契约一致）。
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal?.aborted) { fail(); return }
    signal?.addEventListener('abort', fail, { once: true })
    setTimeout(() => { signal?.removeEventListener('abort', fail); resolve() }, ms)
  })
}

await scenario('提交前 abort（协作工具）：副作用未提交，重试后恰好一次成功提交', async () => {
  let effects = 0
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute(_args, exec) { await sleepWithAbort(60, exec.signal); effects += 1; return [{ type: 'text', text: 'ok' }] } }))
  const ctrl = new AbortController()
  const first = fire(ctx, 'slow', {}, ctrl.signal)
  setTimeout(() => ctrl.abort(), 20) // 提交前取消（工具协作中止）
  const r1 = await first
  assert.equal(r1.isError, true) // aborted → isError/超时形态
  assert.equal(effects, 0) // 协作工具未提交
  const second = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(second.isError, false)
  assert.equal(effects, 1) // 仅一次提交
})

await scenario('提交后 abort：副作用已落库但响应丢失 → 重试再次执行（unknown 缺口复现）', async () => {
  let effects = 0
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute(_args, exec) { effects += 1; await sleepWithAbort(60, exec.signal); return [{ type: 'text', text: 'ok' }] } }))
  const ctrl = new AbortController()
  const first = fire(ctx, 'slow', {}, ctrl.signal)
  setTimeout(() => ctrl.abort(), 20) // 提交后取消 → 响应丢失
  const r1 = await first
  console.log(`  提交后 abort 首调：isError=${r1.isError} effects=${effects}`)
  const r2 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r2.isError, false)
  console.log(`  UNKNOWN_GAP effects=${effects}（第二次执行后）——提交后丢响应无法自动避免重复副作用`)
  if (effects !== 2) throw new Error('期望复现重复提交（effects=2），实际未复现——策略意外安全？需复核')
})

// ---------- 5. Saga 补偿后缓存处理（已知缺口复现，无事务包） ----------
await scenario('Saga 补偿后缓存：补偿成功后同 key 重放旧成功结果（缺口记录）', async () => {
  let creates = 0
  let cancels = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }], ttl: 600 })
  register(ctx, 'create_order', async () => { creates += 1; return [{ type: 'text', text: `order o1 created (#${creates})` }] })
  ctx.tools.register(defineContentToolFixture({ name: 'cancel_order', description: 'cancel', parameters: {},
    async execute() { cancels += 1; return [{ type: 'text', text: 'order o1 cancelled' }] } }))
  const created = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' })
  assert.equal(created.content[0].text, 'order o1 created (#1)')
  const cancelled = await fire(ctx, 'cancel_order', { orderId: 'o1' }) // 补偿成功
  assert.equal(cancelled.isError, false)
  assert.equal(cancels, 1)
  // 同一业务 key 再次发起 create_order：插件重放已撤销订单的成功结果（无失效机制）
  const redo = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' })
  console.log(`  SAGA_GAP redo.isError=${redo.isError} content=${JSON.stringify(redo.content)} creates=${creates}`)
  if (creates !== 1 || redo.content[0].text.includes('#1')) {
    console.log('  → 已复现：补偿后的同 key 请求被重放旧成功结果（需 invalidate/代次/新业务 key，阶段 E）')
  }
})

const failed = results.filter((r) => !r.ok)
console.log(`\nC3_SCENARIOS ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
