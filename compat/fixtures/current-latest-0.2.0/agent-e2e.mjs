/**
 * C2-AgentE2E（registry 0.1.2-rc.1 闭包，无 chaos/transaction）：
 * 用自建公开 API adapter（仅依赖 @deepseek-ai/dsh-llm 导出）驱动真实 agent-loop。
 * 场景：scripted model 连续两次发起完全相同的 create_order 调用（等价于模型/调用方
 * 重复），随后输出文本结束——幂等守卫必须去重：副作用账本 = 1，session 记录两条
 * tool/result 且内容一致，重试（第二次调用）不产生新副作用。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Idempotency from '@why-daydream/dsh-tool-idempotency'
import { createRequire } from 'node:module'
const __require = createRequire(import.meta.url)
const __pluginVersion = __require('@why-daydream/dsh-tool-idempotency/package.json').version
if (__pluginVersion !== '0.2.0') throw new Error(`[VERSION-MISMATCH] 实际加载插件版本 ${__pluginVersion}，期望 0.2.0（候选 tgz 验收）`)
console.log(`[VERSION] plugin loaded = ${__pluginVersion} (0.2.0 候选 tgz)`)


function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char) => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId, name, args) {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 自建公开 API adapter（逐行对齐 tests/mock-adapter.ts，品牌按 0.1.2-rc.1 = ToolCallId）。 */
class ScriptedAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = script
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
    for (const chunk of typeof entry === 'function' ? entry(options) : entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: s, status }) => {
      if (s === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function innerContent(block) {
  return block?.type === 'tool-result' ? block.content : undefined
}

const ctx = new Context()
// mountAgentLoopTestDependencies 已挂载 systemPrompt / tools / sessions / agents / llm；
// AgentLoop@0.1.2-rc.1 还 inject `sessionProjections`，需显式挂载（registry 闭包无其他提供方）。
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Idempotency, { rules: [{ tool: 'create_order', keyArg: 'requestId' }], ttl: 600 })

let executions = 0
ctx.tools.register(defineContentToolFixture({
  name: 'create_order',
  description: 'create an order',
  parameters: {},
  async execute(args) {
    executions += 1
    const { orderId } = args
    return [{ type: 'text', text: `order ${orderId} created (#${executions})` }]
  },
}))

// 脚本：两次完全相同的 create_order（模拟重复/重试），再输出文本结束。
const adapter = new ScriptedAdapter([
  toolCallResponse('c0', 'create_order', { orderId: 'o1', requestId: 'r1' }),
  toolCallResponse('c1', 'create_order', { orderId: 'o1', requestId: 'r1' }),
  textResponse('done'),
])
ctx.llm.registerAdapter(['mock'], adapter)
const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
await waitForIdle(ctx, agent)

// 0.1.2-rc.1 的 Session 以 snapshotEvents() 暴露不可变事件快照（替代旧版 events 可迭代属性）。
const results = agent.session.snapshotEvents().filter(
  (event) => event.type === 'tool/result',
)

console.log(`observations: executions=${executions} toolResults=${results.length} modelRequests=${adapter.requests.length}`)

assert.equal(executions, 1, '副作用账本：重复调用必须只执行一次')
assert.equal(results.length, 2, 'session 记录两条 tool/result')
assert.equal(results[0].data.error, undefined)
assert.equal(results[1].data.error, undefined)
// 第二次（重复）调用重放第一次结果：内部内容一致
assert.deepEqual(innerContent(results[0].data.message.content[0]), innerContent(results[1].data.message.content[0]))
assert.match(JSON.stringify(results[0].data.message.content[0]), /order o1 created \(#1\)/)
assert.ok(adapter.requests.length >= 2, '模型至少发起了两次调用（第一次 + 重复）')
console.log('C2_AGENT_E2E_REGISTRY_OK dedup executed once across model-issued duplicate calls')
