# 升级说明（Upgrade Notes）

适用范围：`@why-daydream/dsh-tool-idempotency` 自 npm `0.1.1` 升级到 **0.1.3 发布候选**
（2026-09-07：兼容 patch + 两个 P0 修复 + `maxInFlight`）。

> 发布状态：**候选已验收、未发布**（npm `latest=0.1.1`）。验收记录见
> `compat/acceptance/acceptance-b-2026-09-07.md` / `acceptance-c-2026-09-07.md`；
> 行为变化与已知限制摘要见 `CHANGELOG.md` [0.1.3]。本版**不是**「无运行时行为变化的
> 兼容 patch」。

## 1. 配置行为变化

| 项 | 0.1.1 / 未发布 0.1.2 线（旧） | P0 加固候选（新） |
| --- | --- | --- |
| `maxInFlight` | 不存在（无独立在途上限） | 新增，默认 `256`；同时**在途**守卫执行数达到上限时，新的**不同 key** 调用被拒绝，返回 `IDEMPOTENCY_CAPACITY_REJECTED` |
| `maxEntries` 淘汰范围 | 总条目上限；满时按 `createdAt` 淘汰**最旧条目（含执行中锁）** ← P0 缺陷 | 只约束**成功结果缓存**；只淘汰已完成项；**执行中锁永不淘汰** |
| 容量满时的处理 | 静默淘汰（可能丢掉执行锁 → 重复副作用） | 新 key 在在途满时**显式拒绝**，绝不绕过守卫执行副作用；同 key 重试不受影响（仍 join） |
| JSON 参数规范化 | 键排序容器为普通 `{}`；自有 `__proto__` 字段被丢 → 两类不同请求被错误合并 | 无原型容器；`__proto__`/`constructor`/`prototype` 等自有 JSON 字段保留，请求按真实参数区分 |
| 错误码 | 仅 `IDEMPOTENCY_KEY_MISMATCH` | 新增 `IDEMPOTENCY_CAPACITY_REJECTED`（`error.info.name = IdempotencyCapacityRejected`，错误结果形态与 mismatch 一致：`isError` + `content` + `error`） |

### 高并发影响（务必评估）

- 默认 `maxInFlight = 256` 意味着：单进程内**同时**在途的受守卫工具调用超过 256 个
  （不同 key）时，多出的调用立即收到结构化容量错误，而不是排队或执行。
- 典型 agent 单会话并发远低于此值；**批量并行工具调用**（一次扇出数百个受守卫调用）
  或**多会话共享一个 Cordis 进程**时可能触达。触达后的表现是确定性的：
  调用方收到 `isError: true` 的容量错误并可自行重试；业务侧若要消除该错误，
  调大 `maxInFlight` 或对超限分支做业务重试策略。

## 2. 升级步骤（上线前）

1. 重建并自测：`npm run typecheck:tests && npm run typecheck && npm run build`，
   再跑 `npm run test:unit`、`npm run test:p0`、`npm run test:e2e`（命令含义见
   `compat/README.md`；当前环境受限时先标 BLOCKED，不得跳过）。
2. 打包验收：`npm pack --dry-run` 确认 `lib/canonicalize.js` 已在 files 白名单
   （见 `package.json`），并在隔离目录用 tgz 严格安装后逐一加载公开入口。
3. **内存 store 升级/重启会丢失历史去重记录**：切换前先停止接收新的受保护写操作，
   等待在途任务完成；存在「已提交但状态未知」的调用先对账再切换。
4. 灰度：不共享存储的内存插件**无法跨实例去重**；多实例灰度需稳定路由 + 下游业务幂等
   或串行切换，不能用简单流量分流宣称灰度安全。

## 3. 回退

- 保存旧精确版本（npm 下载 + integrity）、`compat/targets.lock.json` 与配置快照
  （`compat/snapshots/`）后即可回退二进制；**回退不能恢复业务副作用**。
- 行为升级（scope/key 语义、`unknown` 重试策略、缓存容量语义）尚未合入本候选；
  若未来引入，需单独迁移说明与版本计划（0.2.0 线），不随本候选静默改变。

## 4. 明确不在本版解决的问题（不要过度宣称）

- **unknown 场景**：「副作用已提交但响应丢失/报错」仍然会释放锁并允许重试，可能造成
  重复副作用。本候选**未改变**该策略；安全重试需要下游幂等 key、fencing 或事务证据。
  `isError` 与抛错 = 「可重试」≠「一定安全重试」。
- 跨进程/持久化、多实例去重、租约与崩溃恢复：不在本版，见审计方案的未来里程碑。
- 32 位 FNV 指纹碰撞风险（P1）、显式/隐式 key 的作用域隔离（P1）：未在本候选处理。

## 5. 发布版本计划

- 仓库 `package.json` 仍为 `0.1.2`（未发布）。若「兼容 patch + P0 修复」一起作为下一
  候选发出，需确认 `0.1.2` 尚未被任何 tag/发布流程固定；不能让已验证标签指向另一份
  内容。最终版本号与发布门禁（同 tgz 构建→测试→发布→下载复验）按审计方案阶段 D 执行。
