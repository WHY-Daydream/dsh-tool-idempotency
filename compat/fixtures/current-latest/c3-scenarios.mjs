/**
 * C3 场景（registry 0.1.2-rc.1 闭包，仅公开 API）— 修订版（2026-09-07 代码评审后）
 *
 * 修订点：
 * - 取消场景改用显式 started/joined 屏障 + 场景超时护栏，不再“fire 后立即 abort”
 *   （评审 P1-1）；waiter 独立退出语义已由插件实现（abort-aware join）。
 * - 输出三态：PASS / KNOWN_DEFECT_REPRODUCED / FAIL，正确性通过与已知缺陷复现分账
 *   （评审 P2-3）。发布门禁接受以下 KNOWN_DEFECT：
 *     K1 unknown：副作用已提交但响应丢失（abort/超时）→ 重试再次执行（effects=2）
 *     K2 Saga 补偿后一致性：补偿成功后同业务 key 被重放旧成功结果
 * - Saga 场景补精确断言：必须观察到 creates=1 且重放内容为旧结果，否则 FAIL。
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
/** 轮询屏障：直到 predicate 成立（确定性就绪同步，取消测试专用）。 */
async function until(predicate, timeoutMs = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until(...) timed out after ${timeoutMs}ms`)
    await sleep(1)
  }
}
/** 场景超时护栏：防止回归为永久挂起时套件无限阻塞。 */
function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}

const results = []
const KNOWN_DEFECTS = {
  K1: 'unknown：副作用已提交但响应丢失（abort/超时）后重试再次执行（effects=2）',
  K2: 'Saga 补偿后一致性：补偿成功后同业务 key 请求被重放旧成功结果',
}
async function runScenario(name, fn) {
  try {
    const status = await withTimeout(fn(), 8000, '场景超时（可能回归为永久挂起）')
    if (status !== 'PASS' && status !== 'KNOWN_DEFECT_REPRODUCED') throw new Error(`未预期状态: ${status}`)
    results.push({ name, status })
    console.log(`${status} ${name}`)
  } catch (err) {
    results.push({ name, status: 'FAIL' })
    console.log(`FAIL ${name}\n  ${err.message}`)
  }
}

// ---------- 1. 结构化结果重放 ----------
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

// ---------- 2. waiter 取消（真实进入 join 后取消，事件化 joined 屏障） ----------
await runScenario('waiter 取消：owner 启动后 waiter 确认 join 再被 abort → waiter 独立退出，owner 不受影响', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // joined 屏障（评审建议的事件通知，替代 sleep）：在插件之前注册透传探针，
  // 监听 tools/execute 链上携带 waiter signal 的 dispatch；插件 listener 在该
  // 同步链内完成 guard（join 决策为同步），gate 续体在微任务中执行 → 触发 abort
  // 时 waiter 必然已进入 join 分支。
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
  await until(() => attempts === 1) // started 屏障：owner 已启动并持有执行锁
  const waiter = fire(ctx, 'create_order', { orderId: 'o1' }, waiterCtrl.signal) // 同 key → 必经 join 分支
  await withTimeout(joinedGate.promise, 1000, 'waiter 的 dispatch 未到达 tools/execute 链（joined 屏障超时）')
  assert.equal(attempts, 1)

  waiterCtrl.abort()
  // 修订语义：waiter 必须独立退出（owner 仍未完成），由 400ms 护栏判定；旧实现会挂起到此超时
  const waiterResult = await withTimeout(
    waiter.then((v) => ({ kind: 'resolve', isError: v.isError }), () => ({ kind: 'reject' })),
    400,
    'waiter 在 owner 未完成时未能独立退出（abort-aware join 未生效或回归）',
  )
  assert.equal(waiterResult.kind, 'resolve')
  assert.equal(waiterResult.isError, true) // registry 将 join 取消映射为 isError 结果
  assert.equal(attempts, 1) // owner 未被取消

  gate.resolve([{ type: 'text', text: 'order-1' }])
  const ownerResult = await withTimeout(owner, 1000, 'owner 未能在 gate 释放后完成')
  assert.equal(ownerResult.isError, false)
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(replay.isError, false)
  assert.equal(replay.content[0].text, 'order-1')
  assert.equal(attempts, 1)
  return 'PASS'
})

// ---------- 3. owner 取消（owner 自身 abort，任务仍在执行） ----------
await runScenario('owner 取消：无僵尸锁/无挂起；提交后被取消的结果不缓存 → 重试重执行（K1 族）', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const ownerCtrl = new AbortController()
  const owner = fire(ctx, 'create_order', { orderId: 'o1' }, ownerCtrl.signal)
  await until(() => attempts === 1) // started 屏障
  ownerCtrl.abort() // owner 取消（工具 body 仍在执行，取消不抛弃已启动 body）
  const joiner = fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal) // join
  await sleep(25)
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [rOwner, rJoin] = await withTimeout(Promise.allSettled([owner, joiner]), 1000, 'owner/joiner 未能在 gate 释放后结束')
  // 不变量：在途期间无重复执行、无僵尸锁、无挂起
  assert.equal(attempts, 1, '在途期间不得重复执行')
  assert.equal(rOwner.status, 'fulfilled')
  assert.equal(rJoin.status, 'fulfilled')
  console.log(`  owner 观察：rOwner 已结束（registry 将已完成但已取消的结果映射为 aborted），joiner.isError=${rJoin.value.isError}`)

  // K1 族精确断言：owner 提交后取消 → host 返回 aborted(isError) → 插件不缓存 → 同 key 重试重新执行
  const replay = await fire(ctx, 'create_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(replay.isError, false)
  assert.equal(attempts, 2, 'K1 族未按预期复现：owner 提交后取消后重试应重新执行（attempts=2）')
  console.log(`  K1 族复现确认：owner 提交后被取消 → 结果不缓存（aborted），重试重新执行 attempts=${attempts}`)
  return 'KNOWN_DEFECT_REPRODUCED'
})

// ---------- 4. 提交前 vs 提交后 abort（= 超时/取消前后等价面） ----------
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal?.aborted) { fail(); return }
    signal?.addEventListener('abort', fail, { once: true })
    setTimeout(() => { signal?.removeEventListener('abort', fail); resolve() }, ms)
  })
}

await runScenario('提交前 abort（协作工具）：副作用未提交，重试后恰好一次成功提交', async () => {
  let effects = 0
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute(_args, exec) { await sleepWithAbort(60, exec.signal); effects += 1; return [{ type: 'text', text: 'ok' }] } }))
  const ctrl = new AbortController()
  const first = fire(ctx, 'slow', {}, ctrl.signal)
  setTimeout(() => ctrl.abort(), 20) // 提交前取消（工具协作中止）
  const r1 = await withTimeout(first, 1000, '提交前 abort 首调未结束')
  assert.equal(r1.isError, true)
  assert.equal(effects, 0) // 协作工具未提交
  const second = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(second.isError, false)
  assert.equal(effects, 1) // 仅一次提交
  return 'PASS'
})

await runScenario('提交后 abort：副作用已落库但响应丢失 → 重试再次执行（KNOWN_DEFECT K1）', async () => {
  let effects = 0
  const ctx = await boot({ rules: [{ tool: 'slow' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'slow', description: 'slow', parameters: {},
    async execute(_args, exec) { effects += 1; await sleepWithAbort(60, exec.signal); return [{ type: 'text', text: 'ok' }] } }))
  const ctrl = new AbortController()
  const first = fire(ctx, 'slow', {}, ctrl.signal)
  setTimeout(() => ctrl.abort(), 20) // 提交后取消 → 响应丢失
  const r1 = await withTimeout(first, 1000, '提交后 abort 首调未结束')
  assert.equal(r1.isError, true)
  assert.equal(effects, 1, '首调已提交副作用')
  const r2 = await fire(ctx, 'slow', {}, new AbortController().signal)
  assert.equal(r2.isError, false)
  // 精确断言：unknown 缺陷复现 = 第二次执行后 effects 必须为 2；若为 1 说明行为意外变化
  assert.equal(effects, 2, 'K1 未按预期复现（effects!==2），行为可能已变化，需重新评估接受状态')
  console.log(`  K1 复现确认：effects=${effects}（提交后丢响应无法自动避免重复副作用）`)
  return 'KNOWN_DEFECT_REPRODUCED'
})

// ---------- 5. Saga 补偿后缓存处理（KNOWN_DEFECT K2，精确断言） ----------
await runScenario('Saga 补偿后缓存：补偿成功后同 key 请求被重放旧成功结果（KNOWN_DEFECT K2）', async () => {
  let creates = 0
  let cancels = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }], ttl: 600 })
  register(ctx, 'create_order', async () => { creates += 1; return [{ type: 'text', text: `order o1 created (#${creates})` }] })
  ctx.tools.register(defineContentToolFixture({ name: 'cancel_order', description: 'cancel', parameters: {},
    async execute() { cancels += 1; return [{ type: 'text', text: 'order o1 cancelled' }] } }))
  const created = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' }, new AbortController().signal)
  assert.equal(created.content[0].text, 'order o1 created (#1)')
  const cancelled = await fire(ctx, 'cancel_order', { orderId: 'o1' }, new AbortController().signal)
  assert.equal(cancelled.isError, false)
  assert.equal(cancels, 1)
  // 精确断言：补偿后同业务 key 重发 create_order → 必须观察到「重放旧成功结果」
  const redo = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'saga1' }, new AbortController().signal)
  assert.equal(creates, 1, 'K2 未按预期复现：create_order 被重新执行（副作用+1），行为可能已变化')
  assert.equal(redo.isError, false)
  assert.match(redo.content[0].text, /order o1 created \(#1\)/, 'K2 未按预期复现：未重放旧成功结果')
  console.log(`  K2 复现确认：creates=${creates}，redo=${JSON.stringify(redo.content)}（补偿后缓存对业务不可见）`)
  return 'KNOWN_DEFECT_REPRODUCED'
})

// ---------- 汇总与退出码 ----------
const failCount = results.filter((r) => r.status === 'FAIL').length
const knownCount = results.filter((r) => r.status === 'KNOWN_DEFECT_REPRODUCED').length
const passCount = results.length - failCount - knownCount
console.log(`\nC3_SCENARIOS PASS=${passCount} KNOWN_DEFECT_REPRODUCED=${knownCount} FAIL=${failCount}`)
if (knownCount > 0) {
  console.log('KNOWN_DEFECTS_ACCEPTED_BY_RELEASE_GATE:')
  for (const r of results.filter((x) => x.status === 'KNOWN_DEFECT_REPRODUCED')) {
    const id = r.name.includes('K1') ? 'K1' : r.name.includes('K2') ? 'K2' : '?'
    console.log(`  - ${id}: ${KNOWN_DEFECTS[id] ?? r.name}`)
  }
}
process.exit(failCount === 0 ? 0 : 1)
