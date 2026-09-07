/**
 * 共享测试 harness（Phase 2 业务正确性套件，0.1.3 基线）。
 *
 * 约定与 tests/index.spec.ts 完全一致：通过真实 tool registry 管线驱动
 * （system-prompt + ToolRuntime + idempotency 插件），无网络。所有并发用例
 * 使用 started/joined/committed 同步屏障（deferred + until 轮询），
 * 不依赖「等待几十毫秒应该执行到了」。
 */

import { Context } from '@deepseek-ai/cordis'
import { type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Idempotency from '../../src/index.js'
import type { Config, ToolIdempotencyApi } from '../../src/index.js'

// 模块内共享的默认信号（不导出：导出会把 @types/node 的 AbortSignal 类型引入
// 声明命名上下文，触发 TS4023；与 tests/index.spec.ts 的约定一致）。
const testToolSignal = new AbortController().signal

let callSequence = 0
/** 每次派发生成新 callId（同一 harness 内单调递增）。 */
export function nextCallId(): string {
  callSequence += 1
  return `c${callSequence}`
}

/**
 * dsh-llm 的 call-id 品牌 `CallId` → `ToolCallId` 在 0.1.0-rc.5 与 0.1.2-rc.1+
 * 之间改名；按链接包实际导出的符号解析（仅测试用）。
 */
export async function brandCallId(id: string): Promise<never> {
  const llm = (await import('@deepseek-ai/dsh-llm')) as Record<string, unknown>
  const make = (llm.ToolCallId ?? llm.CallId) as ((s: string) => unknown) | undefined
  if (typeof make !== 'function') throw new Error('dsh-llm exports neither ToolCallId nor CallId')
  return make(id) as never
}

/** 启动 system-prompt + tool registry + idempotency 插件。 */
export async function toolHarness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Idempotency, config)
  return ctx
}

/** 注册一个副作用工具：真实执行一次才调用一次 body。 */
export function registerTool(
  ctx: Context,
  name: string,
  body: () => ContentBlock[] | Promise<ContentBlock[]>,
): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      return await body()
    },
  }))
}

/** 通过真实管线派发一次工具调用。 */
export async function executeTool(
  ctx: Context,
  name: string,
  argumentsValue: Record<string, unknown>,
  signal: AbortSignal = testToolSignal,
): Promise<unknown> {
  return ctx.tools.execute({
    callId: await brandCallId(nextCallId()),
    name,
    // JsonValue 在 0.1.0-rc.5 时代由 dsh-tools 主入口再导出、0.1.2-rc.1+ 不再；
    // 擦除的 `never` 让本套件在两个时代都能编译，运行值不受影响。
    arguments: argumentsValue as unknown as never,
    signal,
  })
}

/** 可手动 resolve/reject 的 promise，用于控制 in-flight 时序（committed 屏障）。 */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 轮询直到 predicate 成立（确定性就绪屏障，替代固定 sleep）。 */
export async function until(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(...) timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** 短暂让出事件循环（仅用于推进微任务/宏任务队列，不充当时序保证）。 */
export function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 0.2.0 状态接口（ctx.provide('toolIdempotency') 挂载的服务）。 */
export function idempotencyApi(ctx: Context): ToolIdempotencyApi {
  return ctx.get('toolIdempotency') as ToolIdempotencyApi
}
