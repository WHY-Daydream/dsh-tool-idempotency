# dsh-tool-idempotency 架构设计

> 状态：MVP 设计定稿（2026-08-17）。本文档是实现的规格说明，对应开发顺序 ①–⑥。

## ① 问题边界

**要解决的**：Agent 因 timeout / retry / 结果丢失重复调用副作用工具，产生重复副作用。

```text
create_order()        ← 第一次调用：超时
create_order()        ← Agent 重试：订单被创建两次
```

**边界声明（不做的事）**：

- 不做分布式锁 / 2PC / 跨进程 exactly-once——单进程内去重，多实例场景由官方 `dsh-session-checkpoint-policy` 或事务补偿兜底
- 不做进程崩溃恢复——那是 `dsh-tool-transaction` / checkpoint 领域
- 只对**显式启用**（配置 rule 匹配）的工具生效；无规则匹配时零影响（与 dsh-chaos 同约定）
- 结果复用只针对「可安全重放」的工具；不可逆工具走 `inFlightOnly` 模式（见 ②）

## ② 幂等模型

五个核心概念：

| 概念 | 定义 |
|---|---|
| **idempotencyKey** | 幂等键，标识「同一逻辑调用」。来源二选一：`keyArg` 显式声明（args 中指定字段，如 `requestId`）；缺省时退化为 request fingerprint |
| **request fingerprint** | 规范化指纹 = `hash([toolName, 深度排序后的 canonical args])`。同一 key 必须匹配同一 fingerprint，否则 fail loud |
| **cached result** | key 首次成功后的规范化 `ToolExecutionResult`，TTL 内复用 |
| **in-flight lock** | 执行中的 promise。并发同 key 调用等待它，拿到同一结果，副作用只发生一次 |
| **TTL** | 缓存有效期，过期即失效，重新执行 |

**配置（schemastery，fail-loud 校验）**：

```yaml
idempotency:
  ttl: 3600            # 缓存 TTL（秒），默认 3600
  maxEntries: 1024     # MemoryStore 上限，超出按 createdAt 淘汰最旧
  rules:
    - tool: 'create_order'    # `*` 通配；首条匹配生效
      mode: 'reuse'           # reuse | inFlightOnly | off（默认 reuse）
      keyArg: 'requestId'     # 可选：显式幂等键字段；缺省用 fingerprint
```

- `reuse`：去重 + 复用缓存结果（默认）
- `inFlightOnly`：**不可逆工具**（send_email 等）——并发同 key 去重，但**绝不重放缓存结果**（首次执行可能已实际生效，重放结果不可信）
- `off`：显式关闭（可被更宽模式覆盖）

**结构化错误码**（复用真实错误码约定，`error.info.name` 带 `Idempotency*` 类别）：

| 码 | 含义 |
|---|---|
| `IDEMPOTENCY_KEY_MISMATCH` | 同 key 但 fingerprint 不同（同 key 不同参数）→ fail loud，不执行 |
| `IDEMPOTENCY_INFLIGHT_FAILED` | 等待并发调用时，in-flight 调用失败，等待方拿到同一失败结果 |

## ③ 状态机

每个 key 一条状态记录：

```text
        （无记录）
            │  首次调用
            ▼
        EXECUTING ── next() 成功 ──▶ SUCCEEDED ── TTL 过期 ──▶ （逐出）
            │                          ▲
            │ next() 失败/错误          │ 同 key 同 fingerprint（reuse 模式）
            ▼                          │
          FAILED ──▶（再次同 key 调用时逐出，重新执行）
```

**到达路径决策**：

```text
key 查找
├─ 无记录 → EXECUTING（记 in-flight promise）→ 执行 → SUCCEEDED / FAILED
├─ EXECUTING → fingerprint 一致？→ 等待 in-flight promise → 返回同一结果（并发去重）
│             fingerprint 不一致 → IDEMPOTENCY_KEY_MISMATCH（fail loud）
├─ SUCCEEDED（TTL 内）→ fingerprint 一致？
│   ├─ 一致 → reuse 模式：返回缓存结果（副作用不发生）
│   │        inFlightOnly 模式：仍重新执行（不重放）
│   └─ 不一致 → IDEMPOTENCY_KEY_MISMATCH
├─ SUCCEEDED（TTL 过期）→ 逐出 → 按无记录处理
└─ FAILED → 逐出 → 按无记录处理（重新执行）
```

关键语义：

- **FAILED 不重放**：失败结果不代表「副作用已完成」，重试必须重新执行；这也与 dsh-chaos 的 `dropResult`（副作用发生但结果丢失）互补——若工具真实执行过，重复副作用由 `dsh-tool-transaction` 补偿
- **并发去重**：in-flight promise 是权威；等待方不重新执行
- **缓存结果不可变**：复用前 deep-freeze，不落入后续 listener 的改写

## ④ DSH Tool Pipeline 接入

拦截点分析（基于官方 `packages/core/tools` 语义）：

```text
tool/call → tools/pre-execute（allow/deny/ask）
          → monotonic guards（ctx.tools.guard，同步 deny-only）
          → tools/execute（around-dispatch 包装器，可短路返回）★ 主拦截点
          → tools/post-execute（决策式：替换/附加）☆ 透明性增强
          → tools/result（不可变权威结果）
```

| Hook | 用途 | 说明 |
|---|---|---|
| `tools/execute` | **主拦截点** | around-dispatch 包装器：查 key → 状态机决策 → 短路返回缓存/等待 in-flight / 调 `next()` 执行并记录结果。签名：`(exec, next) => Promise<ToolExecutionResult>` |
| `tools/post-execute` | 模型透明性 | 通过 `WeakMap<token, {reused, key}>`（wrapper 写入）识别「复用结果」，向决策附加 `additionalContexts` 提示（复用 repeat-tool-reminder 的 `prependContext` 惯用法，source 为 `{kind:'plugin'}`） |
| `tools/pre-execute` / `guard` | 预留 | 当前版本不用 guard 做主逻辑（guard 同步执行、不能 await in-flight）；若后续要「秒拒已知 key 的并发副本」，可在此加同步短路，文档化即可 |

实现要点（沿用 dsh-chaos / repeat-tool-reminder 已验证模式）：

- `exec.name` / `exec.arguments`（已 deep-frozen 的解析后 JSON）/ `exec.signal`（abort 感知）
- 参数规范化：深度 key 排序后 `JSON.stringify`（复用 repeat-tool-reminder 的 `sortJsonValue` 惯用法）
- `exec.agent` 为 `undefined` 的直接 `ctx.tools.execute()` 调用方同样生效（这是设计意图：服务/工作流场景也要幂等）
- abort 语义：in-flight 等待方收到 `exec.signal` abort 时应放弃等待（不挂住被取消的 turn），复用 chaos 的 `delay(ms, signal)` 模式

## ⑤ 存储抽象

```ts
interface IdempotencyStore {
  get(key: string): Entry | undefined
  put(key: string, entry: Entry): void
  delete(key: string): void
}
```

- **`MemoryStore`（MVP）**：`Map<string, Entry>` + 懒过期（查询时按 `expiresAt` 判断）+ `maxEntries` 上限（超出按 `createdAt` 淘汰最旧）。无外部依赖，零网络
- **RedisProvider（后续）**：同一接口，key → JSON 序列化 Entry，配 TTL 原生过期；按需扩展，不进 MVP

## ⑥ 危险场景清单（= 单元测试矩阵）

| # | 场景 | 期望行为 |
|---|---|---|
| 1 | 同 key 不同参数 | `IDEMPOTENCY_KEY_MISMATCH` 错误结果，工具不执行 |
| 2 | 并发重复调用（同 key 同参数） | 工具执行 1 次，两个调用拿到同一结果 |
| 3 | 首次调用失败（工具返回 error） | 记录 FAILED；再次同 key 调用重新执行 |
| 4 | 超时后 retry（首调超时） | 首调 FAILED → retry 重新执行（E2E 与 dsh-chaos 组合） |
| 5 | TTL 过期 | 缓存失效，重新执行 |
| 6 | irreversible（inFlightOnly） | 并发去重；成功缓存**不重放** |
| 7 | keyArg 缺失 | 回退 request fingerprint |
| 8 | 非 opt-in 工具 | 零影响透传（无 rule 匹配 = 插件空转） |
| 9 | 复用结果附加提示 | post-execute `additionalContexts` 携带 reused 说明（模型可见） |
| 10 | fail-loud 配置校验 | 非法 mode / ttl / maxEntries / 空 rules 数组 → 加载即抛错 |

## 与套件的关系

```text
dsh-chaos 制造 timeout/429 → Agent retry → dsh-tool-idempotency 防重复副作用
    → 仍失败 → dsh-tool-transaction Saga 补偿
```

价值最高的 E2E（下一阶段）：

```text
create_order → dsh-chaos 注入 timeout → Agent 判断失败并 retry
    → 再次 create_order → dsh-tool-idempotency 发现同 key
    → 不再次执行真实副作用 → 返回第一次执行的结果
```

## 里程碑

1. ✅ 命名统一（`dsh-tool-idempotency`，仓库 + npm）
2. ✅ 架构设计（本文档）
3. ✅ 包骨架（package.json / tsconfig / cordis.patch.yml / invariant companion）
4. ✅ 核心实现（Config + apply + MemoryStore；`ctx.idempotency` 服务 API 推迟到 v1.1）
5. ✅ pipeline 接入（tools/execute 主拦截：reuse / in-flight 加入 / mismatch fail-loud；post-execute 模型提示推迟到 v1.1——需要 dsh-llm/dsh-session 依赖）
6. ✅ 单元测试（16/16 通过：vitest 4.1；oxlint 0 告警；tsc 0 错误）
7. ⏳ E2E（见下节设计，下一阶段实现）
8. ⏳ 发布：npm 0.1.0 → tag v0.1.0 → GitHub Release（代码就绪，待用户决策）

## E2E 设计（下一阶段，⑧⑨）

### 场景 A：chaos timeout → agent retry → 幂等复用（最高价值）

```text
create_order（真实副作用计数器）
  → dsh-chaos 注入 timeout（首调 afterMs 内不返回 → TOOL_TIMEOUT）
  → Agent 判断失败并 retry（同一工具 + 相同参数）
  → dsh-tool-idempotency 命中同一 fingerprint key
  → 不再次执行真实副作用 → 返回第一次执行的结果
```

**断言**：

- 副作用计数器 === 1（真实执行只有一次）
- 两次 `tool/result` 的 content 一致（重试拿到的是首次结果）
- session log 中同时出现 chaos 注入的 `TOOL_TIMEOUT` 与复用后的成功结果

**测试基建**（复用 monorepo 已验证模式）：

- devDeps 追加（`link:../deepseek-harness/...`）：`dsh-agent-loop-testkit`（`mountAgentLoopTestDependencies`）、`dsh-agent` / `dsh-agent-loop`（agent loop 本体）、`dsh-chaos`（monorepo `packages/guard/chaos` 或 npm 0.1.0）
- 脚本化模型：`MockAdapter`（脚本化 `StreamChunk`）——首轮 tool/call 后以 `TOOL_TIMEOUT` error finish 结束，agent 因此 retry；次轮正常 `stop`。全程无网络
- 插件装配：`SystemPrompt` → `ToolRuntime` → `dsh-chaos`（`rules: [{tool: 'create_order', timeout: {afterMs, probability: 1}}]`）→ `dsh-tool-idempotency`（`rules: [{tool: 'create_order'}]`）

### 场景 B：transaction 组合（补偿兜底）

```text
create_order ✅ → reserve_inventory ✅ → charge_payment ❌（chaos 注入 HTTP_500）
  → 幂等：charge_payment 的 retry 不再重复副作用
  → transaction：无法继续时逆序补偿 release_inventory → cancel_order → ROLLED_BACK
```

**断言**：订单只创建一次、库存只扣一次、补偿恰好各执行一次、最终 `ROLLED_BACK`。

### 验收顺序

1. E2E 场景 A 通过 → 2. E2E 场景 B 通过 → 3. 发布：npm 0.1.0 → tag v0.1.0 → GitHub Release

