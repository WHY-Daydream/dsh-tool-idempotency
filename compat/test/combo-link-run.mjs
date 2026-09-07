/**
 * transaction × idempotency 组合冒烟（本地 link 模式，无网络）
 *
 * 与 fixture 版 combo-acceptance.mjs 场景逻辑一致（commit/rollback/unknown/
 * stale executionId），但宿主包从仓库 node_modules 解析（0.1.0-rc.5 线），
 * idempotency/transaction 用本地 lib。用途：在 clean install（GATE-TI-1，需网络）
 * 之前先行验证**组合调用链逻辑**（GATE-TI-2/3/4 运行时正确性）。
 *
 * 注意：本脚本是 link 预验证，**不替代** fixture 的 npm ci 验收（test-matrix §14.2
 * GATE-TI-1 仍以 clean install 为准）。
 *
 * 运行：node compat/test/combo-link-run.mjs
 * 退出码：0=ALL PASS；非零=FAIL。
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as TransactionPlugin from 'file:///mnt/workspace/DSH/dsh-tool-transaction/lib/index.js'
import * as Idempotency from '../../lib/index.js'

const vIdem = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const vTx = JSON.parse(readFileSync('/mnt/workspace/DSH/dsh-tool-transaction/package.json', 'utf8')).version
const vCordis = JSON.parse(readFileSync(new URL('../../node_modules/@deepseek-ai/cordis/package.json', import.meta.url), 'utf8')).version
const vTools = JSON.parse(readFileSync(new URL('../../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url), 'utf8')).version
console.log(`[VERSION] link 模式：idempotency=${vIdem} transaction=${vTx} cordis=${vCordis} dsh-tools=${vTools}（宿主线 0.1.0-rc.5，非 GATE-TI target 线）`)
if (vIdem !== '0.2.0' || vTx !== '0.1.0') {
  console.error('[COMBO-LINK] FAIL: 版本不符')
  process.exit(1)
}

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 2000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() 超时')
    await sleep(5)
  }
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(TransactionPlugin, {})
await ctx.plugin(Idempotency, {
  rules: [
    { tool: 'side_effect', keyArg: 'orderId' },
    { tool: 'response_lost', keyArg: 'orderId' },
  ],
  maxEntries: 128,
  maxUnknown: 64,
  maxInFlight: 32,
  ttl: 3600,
})
const api = ctx.get('toolIdempotency')

const ledger = []
const compensated = []
let sideEffectCalls = 0
let responseLostCalls = 0
let gateMode = false // 仅场景 4 armed：gate 控制只对该场景内的 side_effect 调用生效
let gateCalls = 0
const gateA = { promise: null, rejectFn: null }
const gateB = { promise: null, rejectFn: null }
const gates = [gateA, gateB]

ctx.tools.register(defineContentToolFixture({
  name: 'side_effect',
  description: 'side effect tool (compensatable)',
  parameters: {},
  async execute() {
    sideEffectCalls += 1
    if (gateMode) {
      const gate = gates[gateCalls] // 场景 4 内第 1/2 次调用 → gateA/gateB
      gateCalls += 1
      await new Promise((resolve, reject) => {
        gate.promise = { resolve, reject }
        gate.rejectFn = (err) => reject(err)
      })
    }
    ledger.push(`effect:${sideEffectCalls}`)
    return [{ type: 'text', text: 'ok' }]
  },
}))
ctx.tools.register(defineContentToolFixture({
  name: 'response_lost',
  description: 'side effect success then response lost (no commit evidence)',
  parameters: {},
  async execute() {
    responseLostCalls += 1
    ledger.push(`effect:rl${responseLostCalls}`)
    throw new Error('response lost after commit')
  },
}))
ctx.tools.register(defineContentToolFixture({
  name: 'failing',
  description: 'plain failure tool (not idempotency-guarded)',
  parameters: {},
  async execute() {
    throw new Error('boom')
  },
}))

const fire = (name, argumentsValue) => ctx.tools.execute({
  callId: brand(`c${++seq}`),
  name,
  arguments: argumentsValue,
  signal: new AbortController().signal,
})

const failures = []
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures.push(name)
}

// ---------- 场景 1：commit 路径（GATE-TI-2 + TI-3-commit） ----------
console.log('[COMBO-LINK] 场景 1 commit 路径')
{
  const tx = ctx.transaction.begin()
  await tx.step({
    name: 'create-order',
    execute: async () => {
      const r = await fire('side_effect', { orderId: 'k1' })
      if (r.isError) throw new Error(`step failed: ${JSON.stringify(r.error)}`)
      return r
    },
    compensate: async () => compensated.push('k1-compensated'),
  })
  await tx.commit()
  check('commit 后 transaction 状态', tx.state === 'COMMITTED', tx.state)
  check('副作用恰执行 1 次', ledger.filter((x) => x === 'effect:1').length === 1)
  check('idempotency k1 = succeeded', api.query('side_effect', { orderId: 'k1' })?.state === 'succeeded')
  const retry = await fire('side_effect', { orderId: 'k1' })
  check('重试重放成功', !retry.isError)
  check('重试未重复副作用', ledger.filter((x) => x === 'effect:1').length === 1, `ledger=${JSON.stringify(ledger)}`)
  check('重放结果来自缓存', retry.content?.[0]?.text === 'ok')
}

// ---------- 场景 2：rollback 路径（GATE-TI-3-rollback） ----------
console.log('[COMBO-LINK] 场景 2 rollback 路径')
{
  const tx = ctx.transaction.begin()
  await tx.step({
    name: 's1',
    execute: async () => {
      const r = await fire('side_effect', { orderId: 'k2' })
      if (r.isError) throw new Error('s1 failed')
      return r
    },
    compensate: async () => compensated.push('k2-compensated'),
  })
  let s2Failed = false
  try {
    await tx.step({
      name: 's2',
      execute: async () => {
        const r = await fire('failing', { orderId: 'k2b' })
        if (r.isError) throw new Error('s2 failed')
        return r
      },
    })
  } catch {
    s2Failed = true
  }
  await tx.rollback()
  check('step2 失败', s2Failed)
  check('rollback 后状态', tx.state === 'ROLLED_BACK', tx.state)
  check('补偿 reverse-order 执行', compensated.includes('k2-compensated'), JSON.stringify(compensated))
  check('idempotency k2 保持 succeeded（补偿不破坏守卫记录）', api.query('side_effect', { orderId: 'k2' })?.state === 'succeeded')
}

// ---------- 场景 3：unknown 路径（GATE-TI-3-unknown） ----------
console.log('[COMBO-LINK] 场景 3 unknown 路径')
{
  const tx = ctx.transaction.begin()
  let stepFailed = false
  try {
    await tx.step({
      name: 's1',
      execute: async () => {
        const r = await fire('response_lost', { orderId: 'k3' })
        if (r.isError) throw new Error('response lost step failed')
        return r
      },
    })
  } catch {
    stepFailed = true
  }
  await tx.rollback()
  check('step 失败', stepFailed)
  const state = api.query('response_lost', { orderId: 'k3' })
  check('idempotency k3 = unknown（响应丢失不得猜成功）', state?.state === 'unknown', state?.state)
  const retry = await fire('response_lost', { orderId: 'k3' })
  check('自动重试被 STATE_UNKNOWN 阻止', retry.error?.info?.code === 'IDEMPOTENCY_STATE_UNKNOWN', JSON.stringify(retry.error ?? retry))
  check('副作用未重复', responseLostCalls === 1, `calls=${responseLostCalls}`)
  const rel = api.release('response_lost', { orderId: 'k3' })
  check('对账 release 成功', rel.ok)
  check('release 后记录解除', api.query('response_lost', { orderId: 'k3' }) === undefined)
}

// ---------- 场景 4：stale executionId（GATE-TI-4） ----------
console.log('[COMBO-LINK] 场景 4 stale executionId 不得作用于新 transaction execution')
{
  gateMode = true // armed：仅本场景的 side_effect 调用由 gate 控制挂起
  const txA = ctx.transaction.begin()
  const pA = (async () => {
    try {
      await txA.step({
        name: 'a',
        execute: async () => {
          const r = await fire('side_effect', { orderId: 'k4' })
          if (r.isError) throw new Error('a failed')
          return r
        },
      })
    } catch { /* step failed */ }
  })()
  await until(() => gateCalls === 1 && gateA.promise !== null)
  const gA = api.query('side_effect', { orderId: 'k4' })?.executionId
  check('txA 执行中（executionId-A 存在）', typeof gA === 'string')
  gateA.rejectFn(new Error('boom'))
  await pA
  await txA.rollback()
  check('A 失败后 idempotency k4 = unknown', api.query('side_effect', { orderId: 'k4' })?.state === 'unknown')
  const relA = api.release('side_effect', { orderId: 'k4' }, { expectedExecutionId: gA })
  check('正确 token release(A) 成功', relA.ok, JSON.stringify(relA))
  const txB = ctx.transaction.begin()
  const pB = (async () => {
    try {
      await txB.step({
        name: 'b',
        execute: async () => {
          const r = await fire('side_effect', { orderId: 'k4' })
          if (r.isError) throw new Error('b failed')
          return r
        },
      })
    } catch { /* step failed */ }
  })()
  await until(() => gateCalls === 2 && gateB.promise !== null)
  const gB = api.query('side_effect', { orderId: 'k4' })?.executionId
  check('txB 执行中（executionId-B 存在且 ≠ A）', typeof gB === 'string' && gB !== gA)
  const staleRel = api.release('side_effect', { orderId: 'k4' }, { expectedExecutionId: gA })
  check('stale release(A) 拒绝', !staleRel.ok && String(staleRel.error).includes('GENERATION_MISMATCH'), JSON.stringify(staleRel))
  const verified = { isError: false, content: [{ type: 'text', text: 'verified' }], value: [{ type: 'text', text: 'verified' }] }
  const staleConfirm = api.confirm('side_effect', { orderId: 'k4' }, verified, { expectedExecutionId: gA })
  check('stale confirm(A) 拒绝', !staleConfirm.ok && String(staleConfirm.error).includes('GENERATION_MISMATCH'))
  const staleInvalidate = api.invalidate('side_effect', { orderId: 'k4' }, { expectedExecutionId: gA })
  check('stale invalidate(A) 拒绝', !staleInvalidate.ok && String(staleInvalidate.error).includes('GENERATION_MISMATCH'))
  const stateB = api.query('side_effect', { orderId: 'k4' })
  check('B 仍 executing 且属于 gB', stateB?.state === 'executing' && stateB.executionId === gB, JSON.stringify(stateB))
  gateB.rejectFn(new Error('boom'))
  await pB
  await txB.rollback()
  check('B 失败后 idempotency k4 = unknown（gB）', api.query('side_effect', { orderId: 'k4' })?.state === 'unknown')
}

if (failures.length > 0) {
  console.log(`[COMBO-LINK] FAIL(${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('[COMBO-LINK] ALL PASS（GATE-TI-2 调用链 / TI-3 commit+rollback+unknown / TI-4 stale fencing，link 预验证）')
process.exit(0)
