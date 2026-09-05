# dsh-tool-idempotency — Latest-DSH Compatibility Audit（audit-only）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `7aab1b9`，published v0.1.1）
**方法**: 复用 dsh-chaos / dsh-tool-bulkhead 的 PCA-01~10 模板（audit-first，不改 production、不发布）。
**铁律**: 能安装 ≠ 能注册 ≠ 幂等语义没变；PCA-09（runtime golden）优先于 peer range。

## 开发基线（devDeps link → 本地 deepseek-harness 工作树）

| package | link 版本 |
|---|---|
| @deepseek-ai/cordis | 4.0.1 |
| @deepseek-ai/dsh-agent | 0.1.0-rc.5（仅 E2E tests） |
| @deepseek-ai/dsh-agent-loop | 0.1.0-rc.5（仅 E2E tests） |
| @deepseek-ai/dsh-agent-loop-testkit | 0.1.0-rc.5（仅 E2E tests） |
| @deepseek-ai/dsh-invariants | 0.1.0-rc.5 |
| @deepseek-ai/dsh-llm | 0.1.0-rc.5（仅 tests） |
| @deepseek-ai/dsh-session | 0.1.0-rc.5（仅 E2E tests） |
| @deepseek-ai/dsh-system-prompt | 0.1.0-rc.5（仅 tests） |
| @deepseek-ai/dsh-tool-call-timeout-policy | 0.1.0-rc.5（仅 tests） |
| @deepseek-ai/dsh-tools | 0.1.0-rc.5 |
| @why-daydream/dsh-chaos | 0.1.0（兄弟插件，仅 tests） |
| @why-daydream/dsh-tool-transaction | 0.1.0（兄弟插件，仅 tests） |

npm 已发布 peer floors（v0.1.1）：cordis `>=4.0.1`、dsh-invariants `>=0.0.1-rc.1`、
dsh-tools `>=0.0.1-rc.1` → 与 chaos/bulkhead 同款裸 prerelease 地板问题（PCA-01 复现）。

## Consumer-symbol 清单（production：src/）

### src/index.ts — apply(ctx, config) 主插件
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` | type | apply(ctx) 参数；事件注册面 |
| @deepseek-ai/dsh-tools | `ToolExecution` | type | exec.name / exec.arguments（fingerprint 与 keyArg 解析） |
| @deepseek-ai/dsh-tools | `ToolExecutionResult` | type | 结构化错误 `{isError, content, error:{message, info:{name, code}}}`（同 chaos/bulkhead 形状） |
| @deepseek-ai/schemastery | `z`（default） | value | `Config: z<Config>` schema（含 default 值解析） |

**消费的 Cordis 契约**：
- `ctx.on('tools/execute', (exec, next) => Promise<ToolExecutionResult>)` — 唯一拦截缝；
  `next()` 委托真实执行；`exec.arguments` 读入指纹
- **错误语义**：`IDEMPOTENCY_KEY_MISMATCH`（同 key 不同 arguments，executing/succeeded 两态）、
  info.name = `IdempotencyKeyMismatch`
- **行为契约（PCA-09 断言面）**：concurrent duplicate join in-flight（同 fingerprint）或
  KEY_MISMATCH（不同 fingerprint）；succeeded + reuse → 重放缓存结果；succeeded + inFlightOnly
  → 删除后重执行；failed → 删除（retry 重执行）；TTL 过期 lazy 删除；FIFO maxEntries 淘汰；
  `off` / 无规则命中 → 完全透传（disabled/baseline）

### src/stores/memory.ts — MemoryStore（依赖 free，非 peer 面）
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/dsh-tools | `ToolExecutionResult` | type | StoreEntry.result 类型 |

契约：state 机 `executing → succeeded|failed`；succeeded 带 `expiresAt`（TTL）；failed 读时删除；
FIFO 淘汰最旧；`now` 可注入（测试）。**纯本地实现，跨 DSH 版本零耦合**（PCA-07 无需比对）。

### src/invariant.ts — tool-idempotency-invariant companion
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` | type | apply(ctx) |
| @deepseek-ai/dsh-invariants | `InvariantInstaller` | type | `ctx.invariants.register(PACKAGE_NAME, install)`；inject ['invariants']；返回 disposer |

## dev/test-only imports（PCA-03/07/08/09 用）
- tests/index.spec.ts: `Context`（cordis）、`CallId` + `ContentBlock`（dsh-llm）、
  `SystemPrompt` default（dsh-system-prompt）、`ToolRuntime` default +
  `defineContentToolFixture` + `JsonValue`（dsh-tools）
- tests/e2e.spec.ts: `Context`（cordis）、`CallId` + `createUserMessage`（dsh-llm）、
  `SessionId` + `SessionEvent`（dsh-session）、`defineContentToolFixture`（dsh-tools）、
  `Agent` type（dsh-agent）、`AgentLoop` default（dsh-agent-loop）、
  `mountAgentLoopTestDependencies`（dsh-agent-loop-testkit）
- **已知 drift 风险（同 chaos F2 / bulkhead F2b-F2d）**：tests 用 `CallId`（dsh-llm 旧名）、
  `JsonValue`（dsh-tools 主入口 0.1.2-rc.1 无导出）；另 E2E 面（session/agent-loop/agent/testkit）
  跨 0.1.0-rc.5 → 0.1.2-rc.1 源码变动较大（llm +1045/−145、core/session +471/−760、
  agent-loop +563/−127）——E2E 测试面 drift 需在 PCA-07 重点核对（若 E2E 无法在 0.1.2-rc.1
  编译，属测试面问题，production 无影响则不影响 patch release 判定）

## PCA-07 比对基线（harness git tags）
- 开发基线: harness 工作树 HEAD（app-boot 0.1.0-rc.5 era）
- 已发布最新: tag `dsh-v0.1.2-rc.1`（= npm next 0.1.2-rc.1 家族）
- 最新源码: tag `dsh-v0.1.3-alpha.1`（2026-09-04）

## PCA-09 golden 场景（idempotency 专属）
1. 同 key 并发重复 → join in-flight（只执行一次副作用）
2. 同 key 不同 arguments → `IDEMPOTENCY_KEY_MISMATCH`（executing 与 succeeded 两态）
3. succeeded + reuse → 重放缓存结果（副作用不重复）
4. failed 结果 → 立即删除，retry 真正重执行
5. TTL 过期 → lazy 删除，后续调用重新执行
6. inFlightOnly → 永不重放缓存；off / 无规则 → 零假阳性透传
7. FIFO maxEntries 淘汰 + fingerprint 绑定
