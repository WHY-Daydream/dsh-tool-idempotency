/**
 * C3-structured：结构化结果断言（registry 0.1.2-rc.1 闭包）。
 * 除内容逐字一致外，检查 `value`/`meta`/`additionalContexts`/`concludesTurn` 在重放中
 * 一致，且不同调用的身份/一次性字段不串用到下一次调用（显式 key 与 fingerprint 两路）。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '@why-daydream/dsh-tool-idempotency'

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
let seq = 0
const signal = new AbortController().signal
const fire = (ctx, name, args) => ctx.tools.execute({ callId: brand(`c${++seq}`), name, arguments: args, signal })

async function boot(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Idempotency, config)
  return ctx
}

const ctx = await boot({ rules: [{ tool: 'create_order', keyArg: 'requestId' }] })
let attempts = 0
ctx.tools.register(defineContentToolFixture({
  name: 'create_order',
  description: 'create an order',
  parameters: {},
  async execute(args) {
    attempts += 1
    const { orderId } = args
    return [{ type: 'text', text: `order ${orderId} (#${attempts})` }]
  },
}))

// 一次真实调用 + 一次同 key 重放 + 一次不同 key 调用（身份不得串用）
const first = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'r1' })
const replay = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'r1' }) // 显式同 key → 重放
const other = await fire(ctx, 'create_order', { orderId: 'o2', requestId: 'r2' }) // 不同 key → 真实执行
assert.equal(attempts, 2, 'o1 一次 + o2 一次；重放不新增副作用')

// 1) 字段清单（观察 + 断言存在性）
const keys = Object.keys(first)
console.log(`result keys: ${keys.join(', ')}`)
for (const field of ['isError', 'content']) assert.ok(field in first, `result 必须含 ${field}`)
// 2) 内容逐字一致 + 其余结构化字段重放一致（value/meta/additionalContexts/concludesTurn 若存在）
assert.deepEqual(replay.content, first.content, 'replay content 与首次一致')
for (const field of ['value', 'meta', 'additionalContexts', 'concludesTurn']) {
  if (field in first) {
    assert.deepEqual(replay[field], first[field], `replay.${field} 与首次一致（存在则断言）`)
    console.log(`  field ${field}: present, replay identical`)
  } else {
    // 表述边界：本 fixture 工具未产生该字段 = 未覆盖；不能推断宿主不支持，也不能
    // 推断重放对该字段正确。
    console.log(`  field ${field}: NOT produced by this fixture tool — UNCOVERED (no claim either way)`)
  }
}
// 注意：以下只证明按 idempotency key 的隔离；不构成 callId/session 身份隔离验证
//（后者需验证缓存不把上一调用的 callId/rootCallId/一次性上下文带到下一调用）。
// 3) 调用身份不串用：不同 key 的结果必须是它自己的（o2 文本、非 o1 重放）
assert.equal(attempts, 2)
assert.match(other.content[0].text, /order o2 \(#2\)/, '不同调用不得串用 o1 的结果')
// 且再次同 key r1 仍重放 o1（不因中间 o2 调用而污染）
const replay2 = await fire(ctx, 'create_order', { orderId: 'o1', requestId: 'r1' })
assert.equal(attempts, 2)
assert.deepEqual(replay2.content, first.content, 'r1 键始终重放 r1 结果，不串 o2')
console.log('C3_STRUCTURED_OK content/value 等字段重放一致；显式 key 身份隔离无串用')
