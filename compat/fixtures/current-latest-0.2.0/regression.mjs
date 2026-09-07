/**
 * C2 完整幂等回归（registry 0.1.2-rc.1 闭包 + 验收用 tgz 插件，仅公开 API）。
 *
 * 覆盖矩阵对齐 tests/index.spec.ts 行为面：透传/off、fingerprint 重放、属性换序、
 * 显式 keyArg、mismatch（执行中+已完成）、并发 join、失败/抛错重试、TTL、
 * inFlightOnly、缓存容量下执行锁不淘汰（A/B/A）、在途容量拒绝、__proto__ 自有字段区分。
 * 每项同时断言副作用次数与结果内容。独立计时器仅 TTL 用例使用。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '@why-daydream/dsh-tool-idempotency'
import { createRequire } from 'node:module'
const __require = createRequire(import.meta.url)
const __pluginVersion = __require('@why-daydream/dsh-tool-idempotency/package.json').version
if (__pluginVersion !== '0.2.0') throw new Error(`[VERSION-MISMATCH] 实际加载插件版本 ${__pluginVersion}，期望 0.2.0（候选 tgz 验收）`)
console.log(`[VERSION] plugin loaded = ${__pluginVersion} (0.2.0 候选 tgz)`)


const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const signal = new AbortController().signal
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

function fire(ctx, name, args = {}) {
  return ctx.tools.execute({ callId: brand(`c${++seq}`), name, arguments: args, signal })
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const cases = []
function case_(name, fn) { cases.push({ name, fn }) }

// ---------- 用例 ----------

case_('无规则命中完全透传，不建幂等记录', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'other_tool', async () => { attempts += 1; return [{ type: 'text', text: 'ok' }] })
  await fire(ctx, 'other_tool', {})
  await fire(ctx, 'other_tool', {})
  assert.equal(attempts, 2)
})

case_('mode off 对命中工具禁用守卫', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', mode: 'off' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: 'ok' }] })
  await fire(ctx, 'create_order', { orderId: 'a' })
  await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(attempts, 2)
})

case_('同 key 同参数重试：reuse 重放，副作用一次且结果一致', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: `order-${attempts}` }] })
  const r1 = await fire(ctx, 'create_order', { orderId: 'a' })
  const r2 = await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(attempts, 1)
  assert.equal(r1.content[0].text, 'order-1')
  assert.equal(r2.content[0].text, 'order-1') // 结构化结果重放：文本与首次一致
})

case_('参数对象字段换序视为同一请求；数组换序视为不同', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 't' }] })
  register(ctx, 't', async () => { attempts += 1; return [{ type: 'text', text: `x-${attempts}` }] })
  await fire(ctx, 't', { a: 1, b: 2 }) // attempt 1 → x-1
  const r2 = await fire(ctx, 't', { b: 2, a: 1 }) // 对象换序 → 同一请求 → 重放
  assert.equal(attempts, 1) // 换序合并，未新增执行
  assert.equal(r2.content[0].text, 'x-1')
  const r3 = await fire(ctx, 't', { xs: [1, 2] }) // 新指纹 → attempt 2 → x-2
  const r4 = await fire(ctx, 't', { xs: [2, 1] }) // 数组换序 = 不同参数 → attempt 3 → x-3
  assert.equal(r3.content[0].text, 'x-2')
  assert.equal(r4.content[0].text, 'x-3') // 数组换序不被合并
  assert.equal(attempts, 3)
})

case_('显式 keyArg 跨调用复用；缺失时回退 fingerprint', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: 'ok' }] })
  await fire(ctx, 'create_order', { requestId: 'r1' })
  await fire(ctx, 'create_order', { requestId: 'r1' })
  assert.equal(attempts, 1) // 显式复用
  await fire(ctx, 'create_order', { orderId: 'x' }) // 无 requestId → fingerprint key
  await fire(ctx, 'create_order', { orderId: 'x' })
  assert.equal(attempts, 2) // fingerprint 命中（未新增执行）
})

case_('同 key 不同参数 → IDEMPOTENCY_KEY_MISMATCH，不执行（已完成态）', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: 'ok' }] })
  await fire(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
  const conflict = await fire(ctx, 'create_order', { requestId: 'r1', orderId: 'b' })
  assert.equal(attempts, 1)
  assert.equal(conflict.isError, true)
  assert.equal(conflict.error.info.code, 'IDEMPOTENCY_KEY_MISMATCH')
})

case_('并发同 key join：工具执行一次，两调用同一结果', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const p1 = fire(ctx, 'create_order', { orderId: 'a' })
  const p2 = fire(ctx, 'create_order', { orderId: 'a' })
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(attempts, 1)
  assert.equal(r1.content[0].text, 'order-1')
  assert.equal(r2.content[0].text, 'order-1')
})

case_('并发同 key 不同参数 → mismatch，冲突方副作用为零', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const p1 = fire(ctx, 'create_order', { requestId: 'r1', orderId: 'a' })
  const p2 = fire(ctx, 'create_order', { requestId: 'r1', orderId: 'b' })
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(attempts, 1)
  assert.equal(r1.isError, false)
  assert.equal(r2.isError, true)
  assert.equal(r2.error.info.code, 'IDEMPOTENCY_KEY_MISMATCH')
})

case_('isError 失败（无提交证据）→ unknown：重试被阻止，release 对账后重新执行（0.2.0 契约）', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => {
    attempts += 1
    if (attempts === 1) throw new Error('boom')
    return [{ type: 'text', text: 'order-ok' }]
  })
  const r1 = await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(r1.isError, true) // 抛错 → dispatcher 转 isError 结果
  const r2 = await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(attempts, 1, '0.2.0：无证据失败 → unknown 阻止自动重试（0.1.3 契约下这里 attempts=2）')
  assert.equal(r2.isError, true)
  assert.equal(r2.error.info.code, 'IDEMPOTENCY_STATE_UNKNOWN')
  // 对账确认未提交 → release → 允许重新执行（受控解除，非自动）
  ctx.get('toolIdempotency').release('create_order', { orderId: 'a' })
  const r3 = await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(attempts, 2)
  assert.equal(r3.isError, false)
  assert.equal(r3.content[0].text, 'order-ok')
})

case_('TTL 过期后重新执行', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }], ttl: 1 })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: `order-${attempts}` }] })
  await fire(ctx, 'create_order', { orderId: 'a' })
  await sleep(1100)
  const r2 = await fire(ctx, 'create_order', { orderId: 'a' })
  assert.equal(attempts, 2)
  assert.equal(r2.content[0].text, 'order-2')
})

case_('inFlightOnly：并发去重，完成后不重放（重试重新执行）', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
  register(ctx, 'send_email', async () => { attempts += 1; return [{ type: 'text', text: `sent-${attempts}` }] })
  const gate = deferred()
  register(ctx, 'send_email2', async () => gate.promise) // placeholder not used
  // inFlightOnly 并发 join：
  const gateCtx = await boot({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
  let gateAttempts = 0
  register(gateCtx, 'send_email', async () => { gateAttempts += 1; return gate.promise })
  const c1 = fire(gateCtx, 'send_email', { to: 'a@x' })
  const c2 = fire(gateCtx, 'send_email', { to: 'a@x' })
  gate.resolve([{ type: 'text', text: 'sent-1' }])
  await Promise.all([c1, c2])
  assert.equal(gateAttempts, 1) // 并发一次
  // 完成后重试重新执行（不重放）：
  await fire(ctx, 'send_email', { to: 'a@x' })
  const again = await fire(ctx, 'send_email', { to: 'a@x' })
  assert.equal(attempts, 2)
  assert.equal(again.content[0].text, 'sent-2')
})

case_('缓存容量=1：执行中锁不被淘汰（A/B/A 交错）', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }], maxEntries: 1 })
  register(ctx, 'create_order', async () => {
    attempts += 1
    if (attempts === 1) return gate.promise
    return [{ type: 'text', text: `order-${attempts}` }]
  })
  const a1 = fire(ctx, 'create_order', { orderId: 'a' }) // 占用执行锁
  const b1 = await fire(ctx, 'create_order', { orderId: 'b' }) // 不同 key，完成并填满缓存
  assert.equal(b1.content[0].text, 'order-2')
  const a2 = fire(ctx, 'create_order', { orderId: 'a' }) // 必须 join（锁未被 B 淘汰）
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [ra1, ra2] = await Promise.all([a1, a2])
  assert.equal(attempts, 2) // A 一次 + B 一次，A 的重试被去重
  assert.equal(ra1.content[0].text, 'order-1')
  assert.equal(ra2.content[0].text, 'order-1')
})

case_('在途容量打满：同 key 重试 join，新 key 返回 CAPACITY_REJECTED 且不执行', async () => {
  let attempts = 0
  const gate = deferred()
  const ctx = await boot({ rules: [{ tool: 'create_order' }], maxInFlight: 1 })
  register(ctx, 'create_order', async () => { attempts += 1; return gate.promise })
  const a1 = fire(ctx, 'create_order', { orderId: 'a' }) // 占唯一槽
  const a2 = fire(ctx, 'create_order', { orderId: 'a' }) // 同 key join
  const refused = await fire(ctx, 'create_order', { orderId: 'b' }) // 新 key → 拒绝
  assert.equal(refused.isError, true)
  assert.equal(refused.error.info.code, 'IDEMPOTENCY_CAPACITY_REJECTED')
  assert.equal(attempts, 1)
  gate.resolve([{ type: 'text', text: 'order-1' }])
  const [ra1, ra2] = await Promise.all([a1, a2])
  assert.equal(attempts, 1)
  assert.equal(ra1.isError, false)
  assert.equal(ra2.isError, false)
  const after = await fire(ctx, 'create_order', { orderId: 'b' }) // 槽释放后可执行
  assert.equal(after.isError, false)
  assert.equal(attempts, 2)
})

case_('__proto__ 自有字段参数不被错误合并', async () => {
  let attempts = 0
  const ctx = await boot({ rules: [{ tool: 'create_order' }] })
  register(ctx, 'create_order', async () => { attempts += 1; return [{ type: 'text', text: `order-${attempts}` }] })
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}')
  const without = JSON.parse('{"a":1}')
  const r1 = await fire(ctx, 'create_order', withProto)
  const r2 = await fire(ctx, 'create_order', without)
  assert.equal(attempts, 2) // 不合并 → 两次真实执行
  assert.equal(r2.content[0].text, 'order-2')
  const r3 = await fire(ctx, 'create_order', withProto) // 相同参数 → 重放
  assert.equal(attempts, 2)
  assert.equal(r3.content[0].text, 'order-1')
})

// ---------- 运行 ----------
let failed = 0
for (const c of cases) {
  try {
    await c.fn()
    console.log(`PASS ${c.name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL ${c.name}\n  ${err.message}`)
  }
}
console.log(`\nC2_REGRESSION ${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
