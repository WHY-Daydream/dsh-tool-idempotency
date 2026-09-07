/**
 * C3-0.2.0 场景（registry 0.1.2-rc.1 闭包 + 本地 0.2.0 候选 tgz，仅公开 API）。
 *
 * 与 current-latest/c3-scenarios.mjs（0.1.3 契约）一一对照的**新契约断言**：
 * - K1（unknown）：0.1.3 下「提交后 abort → 重试再次执行（effects=2）」；
 *   0.2.0 下同场景 → unknown 墓碑 → 重试被阻止（effects 不增），对账 release 后才
 *   允许重新执行。
 * - 证据契约：带 NOT_COMMITTED 证据码的错误（HarnessError code）→ failed_safe，
 *   无墓碑，重试直接重新执行。
 * - K2（Saga 补偿）：0.1.3 下补偿后同 key 被重放旧成功结果；0.2.0 下 invalidate 后
 *   同 key 重新执行并观察到**新业务状态**。
 * - confirm 路径：unknown → 下游确认已提交（写入验证结果）→ 重放验证结果，不重执行。
 *
 * 输出三态：PASS / FAIL（0.2.0 不再接受 KNOWN_DEFECT——K1/K2 必须修复）。
 * 脚本顶部核对实际加载插件版本 === 0.2.0。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '@why-daydream/dsh-tool-idempotency'

const __require = createRequire(import.meta.url)
const __pluginVersion = __require('@why-daydream/dsh-tool-idempotency/package.json').version
if (__pluginVersion !== '0.2.0') throw new Error(`[VERSION-MISMATCH] 实际加载插件版本 ${__pluginVersion}，期望 0.2.0（候选 tgz 验收）`)
console.log(`[VERSION] plugin loaded = ${__pluginVersion} (0.2.0 候选 tgz)`)

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
async function until(predicate, timeoutMs = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until(...) timed out after ${timeoutMs}ms`)
    await sleep(1)
  }
}
function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}

const results = []
async function runScenario(name, fn) {
  try {
    const status = await withTimeout(fn(), 8000, '场景超时（可能回归为永久挂起）')
    if (status !== 'PASS') throw new Error(`未预期状态: ${status}`)
    results.push({ name, status })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, status: 'FAIL' })
    console.log(`FAIL ${name}\n  ${err.message}`)
  }
}

// ---------- 1. 结构化结果重放（0.1.3 同场景，契约不变） ----------
await runScenario('结构化结果重放：不同 callId 得到逐字一致内容，副作用一次', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: `order o1 created (#${attempts})` }] })
  const r1 = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  const r2 = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(attempts, 1)
  assert.equal(r1.isError, false)
  assert.equal(r2.isError, false)
  assert.deepEqual(r1.content, r2.content)
  assert.equal(r2.content[0].text, 'order o1 created (#1)')
  return 'PASS'
})

// ---------- 2. waiter 取消（0.1.3 同场景，契约不变） ----------
await runScenario('waiter 取消：owner 启动后 waiter 确认 join 再被 abort → waiter 独立退出，owner 不受影响', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const waiterCtrl = new AbortController()
  const joinedGate = deferred()
  ctx.on('tools/execute', (exec, next) => {
    const result = next()
    if (exec.signal === waiterCtrl.signal) joinedGate.resolve(true)
    return result
  })
  await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })

  const ownerCtrl = new AbortController()
  const owner = fire(ctx, 'create_order', { orderId: 'o1' }, ownerCtrl.signal)
  await until(() => attempts === 1)
  const waiter = fire(ctx, 'create_order', { orderId: 'o1' }, waiterCtrl.signal)
  await withTimeout(joinedGate.promise, 1000, 'waiter 的 dispatch 未到达 tools/execute 链（joined 屏障超时）')
  assert.equal(attempts, 1)

  waiterCtrl.abort()
  const waiterResult = await withTimeout(
    waiter.then((v) => ({ kind: 'resolve', isError: v.isError }), () => ({ kind: 'reject' })),
    400,
    'waiter 在 owner 未完成时未能独立退出（abort-aware join 未生效或回归）',
  )
  assert.equal(waiterResult.kind, 'resolve')
  assert.equal(waiterResult.isError, true)
  assert.equal(attempts, 1)

  gate.resolve([{ type: 'text', text: 'order-1' }])
  const ownerResult = await withTimeout(owner, 1000, 'owner 未能在 gate 释放后完成')
  assert.equal(ownerResult.isError, false)
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(replay.isError, false)
  assert.equal(replay.content[0].text, 'order-1')
  assert.equal(attempts, 1)
  return 'PASS'
})

// ---------- 3. K1 修复（对账=已提交）：提交后 abort → unknown，confirm 验证结果后重放 ----------
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal?.aborted) { fail(); return }
    signal?.addEventListener('abort', fail, { once: true })
    setTimeout(() => { signal?.removeEventListener('abort', fail); resolve() }, ms)
  })
}

await runScenario('K1 修复（对账=已提交）：提交后 abort → unknown 阻止重试，confirm 验证结果后重放（副作用不 +1）', async () => {
  let effects = 0
  const ledger = [] // 业务账本：副作用提交即入账
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute(_args, exec) { effects += 1; ledger.push(`commit-${effects}`); await sleepWithAbort(60, exec.signal); return [{ type: 'text', text: `ok-${effects}` }] } }))
  const ctrl = new AbortController()
  const first = fire(ctx, 'slow', {}, ctrl.signal)
  setTimeout(() => ctrl.abort(), 20) // 提交后取消 → 响应丢失（副作用已入账）
  const r1 = await withTimeout(first, 1000, '提交后 abort 首调未结束')
  assert.equal(r1.isError, true)
  assert.equal(effects, 1, '首调已提交副作用')
  assert.deepEqual(ledger, ['commit-1'], '业务账本显示已提交')

  // 0.2.0：重试不得再次执行（对照 0.1.3 的 effects=2 缺陷复现）
  const r2 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r2.error?.info?.code, 'IDEMPOTENCY_STATE_UNKNOWN', '重试应返回结构化 UNKNOWN 错误')
  assert.equal(effects, 1, 'K1 修复：重试未新增副作用')

  // 对账=已提交 → confirm 写入验证结果 → 重试重放，副作用不 +1
  const api = ctx.get('toolIdempotency')
  assert.equal(api.query('slow', {})?.state, 'unknown')
  api.confirm('slow', {}, { isError: false, content: [{ type: 'text', text: 'ok-1' }], value: [{ type: 'text', text: 'ok-1' }] })
  const r3 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r3.isError, false)
  assert.equal(r3.content[0].text, 'ok-1')
  assert.equal(effects, 1, 'confirm 后重放验证结果，不再执行副作用')
  assert.deepEqual(ledger, ['commit-1'], '账本不新增（无重复副作用）')
  console.log(`  K1 修复确认（对账=已提交）：0.1.3 effects=2（自动重执行）→ 0.2.0 重试 blocked → confirm 后重放（effects=1，账本一条）`)
  return 'PASS'
})

// ---------- 3b. K1 修复（对账=未提交）：release 后重新执行，账本恰一条新提交 ----------
await runScenario('K1 修复（对账=未提交）：release 后重新执行，账本恰新增一条（无重复）', async () => {
  let effects = 0
  const ledger = []
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute() { effects += 1; if (effects === 1) throw new Error('failed before commit'); ledger.push(`commit-${effects}`); return [{ type: 'text', text: `ok-${effects}` }] } }))
  const r1 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r1.isError, true)
  assert.equal(effects, 1)
  assert.deepEqual(ledger, [], '业务账本为空：确认未提交')

  // 对账=确认未提交 → release → 重新执行
  const api = ctx.get('toolIdempotency')
  assert.equal(api.query('slow', {})?.state, 'unknown')
  api.release('slow', {})
  const r2 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r2.isError, false)
  assert.equal(effects, 2)
  assert.deepEqual(ledger, ['commit-2'], '账本恰一条新提交，无重复副作用')
  console.log(`  K1 修复确认（对账=未提交）：release 后重新执行（effects=2），账本仅一条新提交`)
  return 'PASS'
})

// ---------- 4. 证据契约：NOT_COMMITTED 证据 → failed_safe，重试直接重新执行 ----------
await runScenario('证据契约：带 NOT_COMMITTED 证据的失败（HarnessError code）→ failed_safe：重试直接重新执行', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => {
    attempts += 1
    if (attempts === 1) throw new llm.HarnessError('not committed', 'IDEMPOTENCY_NOT_COMMITTED')
    return [{ type: 'text', text: `order-${attempts}` }]
  })
  const r1 = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(r1.isError, true)
  assert.equal(r1.error?.info?.code, 'IDEMPOTENCY_NOT_COMMITTED', '宿主应保留 HarnessError 证据码')
  assert.equal(attempts, 1, '首次尝试已发生（body 自增），但带证据声明未提交')
  const r2 = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(r2.isError, false)
  assert.equal(attempts, 2, '有证据确定未提交 → 重试允许重新执行')
  return 'PASS'
})

// ---------- 5. K2 修复：Saga 补偿 invalidate 后同 key 重新执行并观察到新业务状态 ----------
await runScenario('K2 修复：Saga 补偿 invalidate 后，同 key 重发重新执行并观察到新业务状态（无旧结果重放）', async () => {
  let creates = 0
  let cancels = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }], ttl: 600 })
  register(ctx, 'create_order', async () => {
    creates += 1
    return [{ type: 'text', text: creates === 1 ? 'order o1 created (#1)' : 'order o1 recreated (#2) after compensation' }]
  })
  ctx.tools.register(defineContentToolFixture({ name: 'cancel_order', description: 'cancel', parameters: {},
    async execute() { cancels += 1; return [{ type: 'text', text: 'order o1 cancelled' }] } }))
  const created = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' }, new AbortController().signal)
  assert.equal(created.content[0].text, 'order o1 created (#1)')
  const cancelled = await fire(ctx, 'cancel_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(cancelled.isError, false)
  assert.equal(cancels, 1)

  // 补偿流程：使原操作成功缓存失效
  ctx.get('toolIdempotency').invalidate('create_order', { orderId: 'o1', requestId: 'saga1' })

  // 0.2.0：同 key 重发 → 重新执行（对照 0.1.3 的重放旧「已创建」结果 creates=1）
  const redo = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' }, new AbortController().signal)
  assert.equal(creates, 2, 'K2 修复：invalidate 后同 key 重新执行（0.1.3 下这里重放旧结果 creates=1）')
  assert.equal(redo.isError, false)
  assert.match(redo.content[0].text, /recreated \(#2\) after compensation/, '重执行观察到新业务状态，而非重放旧「已创建」')
  console.log(`  K2 修复确认：0.1.3 补偿后重放旧结果（creates=1）→ 0.2.0 invalidate 后重新执行（creates=2，新业务状态）`)
  return 'PASS'
})

// ---------- 6. confirm 路径：unknown → 下游确认已提交 → 重放验证结果，不重执行 ----------
await runScenario('confirm 路径：unknown 状态下游确认已提交（写入验证结果）→ 重放验证结果，不重执行', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => {
    attempts += 1
    if (attempts === 1) throw new Error('boom: response lost but may have committed')
    return [{ type: 'text', text: `order-${attempts}` }]
  })
  const r1 = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(r1.isError, true)
  const api = ctx.get('toolIdempotency')
  assert.equal(api.query('create_order', { orderId: 'o1' })?.state, 'unknown')

  // 下游对账确认副作用确实已提交 → confirm 写入验证结果（完整物化形状）
  api.confirm('create_order', { orderId: 'o1' }, {
    isError: false,
    content: [{ type: 'text', text: 'verified-committed' }],
    value: [{ type: 'text', text: 'verified-committed' }],
  })
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(replay.isError, false)
  assert.equal(replay.content[0].text, 'verified-committed')
  assert.equal(attempts, 1, 'confirm 后重放验证结果，不重新执行')
  return 'PASS'
})

// ---------- 汇总与退出码 ----------
const failCount = results.filter((r) => r.status === 'FAIL').length
const passCount = results.length - failCount
console.log(`\nC3_0.2.0 PASS=${passCount} FAIL=${failCount}（0.2.0 不接受 KNOWN_DEFECT：K1/K2 必须修复）`)
process.exit(failCount === 0 ? 0 : 1)
