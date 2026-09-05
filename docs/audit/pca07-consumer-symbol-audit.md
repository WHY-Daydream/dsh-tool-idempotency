# PCA-07 — consumer-symbol audit（三 ref 比对结论）

**Date**: 2026-09-05 · **Branch**: audit/latest-dsh-compat
**比对基线**: HEAD（开发基线，0.1.0-rc.5 era）→ `dsh-v0.1.2-rc.1`（npm next）→ `dsh-v0.1.3-alpha.1`（最新源码）

## 结论：PCA-07 PASS — production 消费面无破坏性变更

| 消费 symbol | 包 | 三 ref 比对 | 结论 |
|---|---|---|---|
| `ctx.on('tools/execute', (exec, next) => Promise<ToolExecutionResult>)` | dsh-tools | 签名逐字一致（line 163/155/155） | ✅ |
| `ToolExecution` 字段 `name: string` + `arguments: unknown` | dsh-tools | 三 ref 字段一致（line 321-323 / 314-316 / 314-316；idempotency 指纹与 keyArg 读取面全兼容） | ✅ |
| `ToolFailure` 形状 `{message, info?: ToolErrorInfo}` | dsh-tools | 三 ref 逐字一致（idempotencyError 构造 `error:{message, info:{name, code}}` 兼容） | ✅ |
| `ToolExecutionResult = Success \| Failure` | dsh-tools | 三 ref 一致（同 chaos/bulkhead PCA-07 结论） | ✅ |
| cordis `Context` + `ctx.on` | cordis | idempotency 仅用 ctx.on（无 Events augmentation / 无 emit）；Events 面三 ref 一致（chaos/bulkhead PCA-07 已验证 vendor/cordis events.ts:329 + emit 签名逐字一致） | ✅ |
| `InvariantInstaller` + `ctx.invariants.register(packageName, installer): () => void` | dsh-invariants | 三 ref 逐字一致（line 136） | ✅ |
| `z`（@deepseek-ai/schemastery） | schemastery | runtime dep（^3.18.1 → npm 3.18.2 patch），非 peer，无 API 面影响 | ✅ |
| `MemoryStore` | 本地 | 依赖 free（仅 `ToolExecutionResult` 类型），跨版本零耦合 | ✅ |

## Finding F2b'（测试面 drift，同 chaos F2 / bulkhead F2b）
- dsh-llm brand：基线 `CallId` → 0.1.2-rc.1 / 0.1.3-alpha.1 均为 `ToolCallId`（brand.ts line 31/38 已实证）
- 影响：**仅测试面**——`tests/index.spec.ts` 与 `tests/e2e.spec.ts` 的 `import { CallId }` 在
  0.1.2-rc.1+ 类型下不再编译。production src 不 import CallId，零影响。
- 另：`tests/index.spec.ts` 用 `JsonValue`（dsh-tools 主入口 0.1.2-rc.1 无导出，同 bulkhead F2c）

## Finding F2e'（E2E 测试面 drift 风险，记录待 PCA-08 实证）
- `tests/e2e.spec.ts` 消费 session/agent-loop/agent/testkit 面（SessionId/SessionEvent/Agent/
  AgentLoop/mountAgentLoopTestDependencies/createUserMessage），这些包在 0.1.0-rc.5 →
  0.1.2-rc.1 有较大源码变动（llm +1045/−145、core/session +471/−760、agent-loop +563/−127）。
  **E2E 属测试面**；若在 0.1.2-rc.1 类型下不编译，属测试面 drift（F2 类），不阻塞
  patch release 判定（production 消费面已全绿）。PCA-08 clean-room 时实证。

## 含义
idempotency 的 production 消费面（tools/execute 瀑布、ToolExecution.name/arguments、
ToolExecutionResult 错误形状、cordis ctx.on、invariants 注册契约）在
0.1.0-rc.5 era → 0.1.2-rc.1 → 0.1.3-alpha.1 全部未变——「能安装 ≠ 能注册 ≠ 幂等语义没变」
中的安装/注册层有类型证据；语义层由 PCA-09（runtime golden）验证。
