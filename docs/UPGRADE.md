# 升级说明（Upgrade Notes）

适用范围：`@why-daydream/dsh-tool-idempotency` 自 npm `0.1.1` 升级到 **0.1.3 发布候选**
（2026-09-07：兼容 patch + 两个 P0 修复 + `maxInFlight`）。

---

## 0.2.0（开发中，分支 `0.2.0`）— unknown 状态机 + Saga 缓存失效

> 状态：实现与专项测试完成，未发布。**含行为变化**（相对 0.1.3）：不再把所有
> `isError` 解释为「可以重新执行」。CHANGELOG 见 [0.2.0]。

### 1. 失败语义变化（最重要的升级注意）

| 场景 | 0.1.3（旧） | 0.2.0（新） |
| --- | --- | --- |
| 工具抛错 / 返回普通错误结果 | 释放锁，重试**自动重新执行**（可能重复副作用 ← K1） | 进入 **unknown**：重试返回 `IDEMPOTENCY_STATE_UNKNOWN`，**阻止自动重执行**，且不随 TTL 自动解除 |
| 工具/包装器返回带 `error.info.code === 'IDEMPOTENCY_NOT_COMMITTED'` 的错误 | 同普通错误 | **failed_safe**：确定未提交，释放锁且不留记录，重试允许重新执行 |
| 超时 / abort / 响应丢失 | 重试自动重新执行（effects=2） | unknown：重试被阻止，需对账后 `release`/`confirm` |

**迁移要求**：依赖「失败即重试」的工具必须**显式提供 `IDEMPOTENCY_NOT_COMMITTED` 证据码**
（返回结构化错误结果，而非抛错/超时），否则重试会被 unknown 阻止；或由下游在重试前
`query` 状态并 `release`/`confirm`。**无证据时插件不再猜测提交状态。**

### 2. 新接口（`ctx.get('toolIdempotency')`）

| 方法 | 语义 |
| --- | --- |
| `query(name, args)` | 查询 key 状态（executing/succeeded/unknown），无记录返回 undefined |
| `release(name, args)` | 状态解除（下游对账确认无未决提交）：清除 succeeded/unknown，后续同 key 重新执行 |
| `confirm(name, args, result)` | 下游确认已提交：写入验证过的结果（可重放）。result 需为宿主导管可校验的完整物化形状（isError/content/value） |
| `invalidate(name, args)` | 补偿流程：清除 succeeded 缓存并递增代次，防止旧执行写回陈旧结果 |

### 3. Saga 补偿流程（K2 方向）

- 补偿成功后：`invalidate(原操作)` 使原成功缓存失效；同 key 重试将**重新执行**（结合业务
  状态与**新操作身份**决定——仅删除缓存≠可安全重执行）。
- 补偿自身使用独立且稳定的幂等身份（新 key）。
- owner+代次校验：`invalidate` 与「原操作完成」并发到达时，旧执行完成不写回缓存。
- 补偿失败/结果未知：原操作保持 unknown，进入明确的待处理状态，等待对账。

### 4. 范围声明（本版不做）

- 不做 Redis / 多进程持久化；unknown/succeeded 状态仍是**单进程内存语义**。
- 跨重启边界：进程重启后状态丢失，与 0.1.3 一致（文档已声明）。

### 5. 0.2.0 补强项（验收期新增）

- **O1 指纹碰撞修复**：请求指纹由 FNV-1a 32 位升级为 **SHA-256**（node:crypto 内建，
  无新增依赖），并加规范化版本字节 `v1:`。**修复 0.1.3 实测的 FNV 碰撞对**（`12077584`）；
  SHA-256 使不同参数请求错误合并的概率大幅降低，但**不作绝对免碰撞保证**（任何哈希均
  有理论碰撞可能；契约以实测碰撞对回归为准）。进程内缓存，无持久化迁移影响。
- **unknown 墓碑豁免容量淘汰**：`maxEntries` 只约束 succeeded 缓存；unknown 墓碑
  **永不淘汰**（淘汰=静默解除=延迟重复副作用）。代价：未对账的 unknown key 会持续
  占内存（每枚墓碑仅 key+指纹，极小），**对账（release/confirm）即其生命周期**；
  长期不决的 key 需操作方定期对账。`query` 可观测、`release`/`confirm` 可解除。
- **unknown 墓碑容量预算**：新增 `maxUnknown`（默认 1024，独立于 `maxEntries`），
  按**并发预留口径**计数——`unknown + 在途执行 ≤ maxUnknown`（成功结算即释放预留，
  杜绝并发全部失败后突破预算）。墓碑**永不淘汰**但预算有界；预算耗尽时**新受保护
  执行前置拒绝**（`IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED`），对账 `release`/`confirm`
  后恢复。避免「内存无限增长」与「静默解除墓碑」两个极端；长期不决的 key 需操作方
  定期对账。
- **join 可脱离（waiter 集合）**：join 中的 waiter 以集合形式挂在执行条目上，abort 即
  从集合移除并移除监听器——长期未完成 owner 被反复 join/cancel 时不在 owner promise
  上累积 `.then` 处理器（宿主侧 dispatch 记录仍随在途 owner 保留，owner 完成即释放）。
- **代次条目用毕即删**：`generations` 只在「可能有陈旧 owner 未结算」期间驻留
  （settle/fail 后、无在途时的 release/confirm/invalidate 后即删），避免随 key 数
  无限增长。
- **failed_safe 证据可来自抛错**：工具抛 `HarnessError(message, 'IDEMPOTENCY_NOT_COMMITTED')`
  （宿主会保留 `error.info.code`）或返回带证据码的错误结果均可进入 failed_safe；
  普通 Error 的自定义字段会被宿主错误映射丢弃，不能作为证据（无证据→unknown）。

---

## 0.1.3 升级说明（原始内容）

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
