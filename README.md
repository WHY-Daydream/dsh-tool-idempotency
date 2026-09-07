# dsh-tool-idempotency

[English](README.en.md) | 中文

> DeepSeek Harness 的幂等 / 重复执行守卫插件：Agent 因超时/重试重复调用副作用工具时，按幂等键（idempotency key）去重并复用历史结果，防止重复副作用。

> **状态：0.1.3 发布候选（2026-09-07，已验收、未发布）。** npm `latest` 仍为 0.1.1
> （含两个已修复的 P0 缺陷）。0.1.3 候选 = 最新 DSH 兼容 patch + 两个 P0 修复 +
> 新配置 `maxInFlight`——**不是「无运行时行为变化的兼容 patch」**：
> - **行为变化**：新增 `maxInFlight`（默认 256），打满时新的不同 key 调用返回
>   `IDEMPOTENCY_CAPACITY_REJECTED`；`maxEntries` 语义收窄为「成功缓存上限」。
> - **已知限制（本版接受）**：① 副作用已提交但响应丢失/超时后，重试会再次执行
>   （不承诺 exactly-once，需下游幂等/对账）；② Saga 补偿成功后同业务 key 可能重放旧
>   成功结果（invalidate/代次机制属 0.2.0）。两个限制均为 FAIL 复现项，详见
>   `compat/acceptance/acceptance-c-2026-09-07.md` 与 `CHANGELOG.md`；升级注意见
>   `docs/UPGRADE.md`。系列前两款 `dsh-chaos`（故障注入）与 `dsh-tool-transaction`
>   （Saga 补偿）已发布（npm 0.1.0/0.1.1），本插件为第三款。

## 解决什么问题

Agent 超时重试导致的重复副作用：

```text
create_order()        ← 第一次调用：超时
create_order()        ← Agent 重试：订单被创建两次
```

- 工具已执行但结果丢失（超时、`TOOL_RESULT_LOST`、post-execute 故障）时，Agent 会合理地把结果解释为「未执行」并重试，从而重复写入、命令或其他副作用
- 官方社区已确认该 gap：deepseek-ai/deepseek-harness Discussion #1489（post-execute 监听器抛错 → 后续调用全部失败 → Agent 重试造成重复副作用）

## 定位

与官方 `@deepseek-ai/dsh-repeat-tool-reminder`（0.0.1-rc.3）**差异化**：

| | dsh-repeat-tool-reminder（官方） | dsh-tool-idempotency（本插件） |
|---|---|---|
| 行为 | advisory：提醒 Agent 正在循环相同调用 | 强制：按 key 去重，直接复用历史结果 |
| 拦截点 | 观察 | `tools/pre-execute` 后的 monotonic guard |
| 结果复用 | 无 | 有（返回上次规范化结果） |
| 持久化 | 无 | 可选（进程内 Map → 可选存储） |

与 `dsh-tool-transaction` 的分工：**防重复在前（idempotency），补偿在后（transaction）**。

Reliability Suite 完整链路：

```text
dsh-chaos 制造 timeout/429 → Agent retry → dsh-tool-idempotency 防重复副作用 → 仍失败 → dsh-tool-transaction Saga 补偿
```

## 设计

```text
tool/call
   ↓
idempotency key（显式声明，或按 tool + 规范化 args 哈希推导）
   ↓
duplicate?
├─ no  → execute（记录 key → 规范化结果）
└─ yes → reuse previous result（不执行，副作用不发生）
```

- 实现落点：`tools/pre-execute` 之后的 monotonic guard 扩展点（与 `dsh-chaos` 拦截位置同级）；成功路径在 `tools/execute` 包装器中记录结果
- key 来源优先级：显式声明 > 按 tool + 规范化 args 哈希（仅对显式启用幂等的工具生效，避免模型不可见元数据泄漏）
- 只去重「可安全复用的调用」，守卫为 opt-in，不改变未启用工具的语义
- 不承诺多进程/分布式 exactly-once（与官方 checkpoint / 持久化插件可组合）

## 安装

（npm 0.1.0 发布后）

```sh
dsh plugin --profile web add @why-daydream/dsh-tool-idempotency
```

## 使用（设计示例，实现后生效）

```yaml
idempotency:
  ttl: 3600            # 可选：缓存 TTL（秒），默认 3600
  maxEntries: 1024     # 可选：成功结果缓存上限；容量淘汰只作用于已完成缓存，绝不淘汰执行中锁
  maxInFlight: 256     # 可选：同时在途执行上限；打满时拒绝新调用（IDEMPOTENCY_CAPACITY_REJECTED），不执行副作用
  rules:
    - tool: 'create_order'    # `*` 通配；首条匹配生效
      mode: 'reuse'           # reuse | inFlightOnly | off（默认 reuse）
      keyArg: 'requestId'     # 可选：显式幂等键字段；缺省用 request fingerprint
```

```ts
// 显式 key（服务 / 工作流场景）
await ctx.idempotency.run('create_order', { orderId }, async () => createOrder())
```

## Known Limitations and Deferred Work

- **尚未发布**：npm 0.1.0 未发布（代码与单元测试就绪，E2E 与发布待后续）
- **v1.1 推迟项**：`ctx.idempotency` 服务 API 与 post-execute 模型可见复用提示（需要 dsh-llm / dsh-session 依赖）
- 不做分布式锁 / 2PC / 跨进程 exactly-once：多实例场景需组合官方 `dsh-session-checkpoint-policy` 或事务补偿
- 不做进程崩溃恢复：崩溃后的副作用盘点与恢复属于 `dsh-tool-transaction` / checkpoint 领域（官方已实现，该方向已放弃立项）
- 结果复用只对「确定性、可安全重放」的工具开放；不确定工具只去重不缓存

## 生态位置（2026-08-16 扫描结论）

- 同名：GitHub 0 仓库；npm `@why-daydream/dsh-tool-idempotency` 可用
- 官方相邻：`@deepseek-ai/dsh-repeat-tool-reminder`（advisory，见上表）
- 官方已有：`@deepseek-ai/dsh-session-checkpoint-policy`（持久化 checkpoint，Recovery 方向）→ 本插件不做进程级恢复

## 链接

- 仓库：https://github.com/WHY-Daydream/dsh-tool-idempotency
- 系列：`dsh-chaos`（故障注入）· `dsh-tool-transaction`（Saga 补偿）
- 官方文档：[Tool Execution Pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline)
