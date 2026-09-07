/**
 * C1 无插件对照基线（registry 0.1.2-rc.1 闭包，不含本插件）。
 * 目的：证明该固定闭包上工具 pipeline 本身可用、且「无插件 = 无去重」。
 * 只依赖 fixture node_modules（registry 精确版本），不 import 插件仓库 src。
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

let calls = 0
ctx.tools.register(defineContentToolFixture({
  name: 'create_order',
  description: 'create an order',
  parameters: {},
  async execute() {
    calls += 1
    return [{ type: 'text', text: `order-${calls}` }]
  },
}))

const llm = await import('@deepseek-ai/dsh-llm')
const brand = llm.ToolCallId ?? llm.CallId
const signal = new AbortController().signal
const fire = (n) => ctx.tools.execute({ callId: brand(`c${n}`), name: 'create_order', arguments: {}, signal })

const r1 = await fire(1)
const r2 = await fire(2) // 无插件：同 key 同参数第二次必须真实执行
assert.equal(calls, 2, 'control: without the plugin a duplicate call must execute again')
assert.equal(r1.isError, false)
assert.equal(r2.isError, false)
assert.match(r2.content[0].text, /order-2/)
console.log('C1_BASELINE_OK no-plugin duplicate ran twice (calls=2); pipeline OK on registry 0.1.2-rc.1 closure')
