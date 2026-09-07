# C 阶段验收记录 — 2026-09-07

对象：在 **npm registry 0.1.2-rc.1 固定闭包**上验证 `@why-daydream/dsh-tool-idempotency`
P0 加固产物（B 阶段同一份 tgz）。C1–C3 已执行；C4 矩阵状态见文末。

## 固定闭包与证据链

- fixture：`compat/fixtures/current-latest/`（package.json 精确版本 + `package-lock.json` 16.5KB 落库）
- 精确版本：cordis 4.0.2；dsh-tools / dsh-invariants / dsh-system-prompt / dsh-session /
  dsh-llm / dsh-agent-loop / dsh-agent-loop-testkit / dsh-tool-call-timeout-policy **0.1.2-rc.1**；
  插件 = B 阶段验收 tgz（SHA-256 `c0e2781e…2c65`）
- 脚本（均只依赖 fixture node_modules 公开 API，不 import 插件仓库 src）：
  `baseline.mjs`、`regression.mjs`、`c3-scenarios.mjs`
- 运行日志见本文件对应小节；原始输出存档路径：`compat/acceptance/logs/`（B 阶段）

## C1 无插件对照 — PASS

`node baseline.mjs` → `C1_BASELINE_OK`：无插件时同 key 同参数调用真实执行 **2 次**（calls=2），
证明固定闭包 pipeline 可用、无插件即无去重。EXIT 0。

## C2 完整幂等回归（registry 闭包，scripted adapter）— PASS 14/14

`node regression.mjs` → `C2_REGRESSION 14/14 passed`，覆盖：透传不建记录 / mode off /
fingerprint 重放（内容一致）/ 对象换序合并 + 数组换序区分 / 显式 keyArg + 缺失回退 /
mismatch（已完成 + 并发）/ 并发 join / 抛错重试 / TTL 过期重执行 / inFlightOnly /
缓存容量=1 下 A/B/A 执行锁不淘汰 / 在途容量拒绝（同 key join、新 key
`IDEMPOTENCY_CAPACITY_REJECTED`）/ `__proto__` 自有字段不合并。EXIT 0。
（14/14 中含 1 例初跑 FAIL，系本套件自身断言计数错误，修正后全过；插件无缺陷。）

## C2 Agent E2E（registry 闭包）— 基础场景 PASS；上游 scripted-model 缺失用自建 adapter 绕过

- 官方 npm `dsh-agent-loop-testkit@0.1.2-rc.1` 只导出 `mountAgentLoopTestDependencies`；
  MockAdapter 等 scripted-model 是 monorepo 内部文件、未发布 → 插件仓库自建
  `tests/mock-adapter.ts`（仅公开 API），fixture 侧用同款内联 adapter
  （`agent-e2e.mjs`，品牌按 0.1.2-rc.1 取 `ToolCallId`）。
- **基础 Agent E2E（无 chaos/transaction）：PASS**（`node agent-e2e.mjs`，EXIT 0）——
  模型连续两次发起相同 `create_order` → 副作用账本 **executions=1**、session 两条
  tool/result 且内容一致、modelRequests=3。接口差异（已记录，非缺陷）：
  1) AgentLoop@0.1.2-rc.1 inject `sessionProjections`，npm testkit mount 不提供 →
     需显式 `plugin(SessionProjectionRegistry)`；
  2) `agent.session.events` 可迭代属性 → `agent.session.snapshotEvents()`。
- 完整 chaos 驱动（超时→agent 重试）与组合（chaos/transaction）在 registry 闭包仍受
  上游约束（transaction peer ERESOLVE）；本地 dev 宿主 Scenario A/B PASS。

## C3 场景（registry 闭包）— 正确性断言 4 PASS，缺陷复现 2 FAIL（如实分账）

> **判定口径**：「脚本按预期复现了问题」与「插件满足正确性要求」分开记录。下列
> unknown / Saga 两行为缺陷复现，分别记为 **FAIL**；不得因“复现成功”误记为 PASS。

| 场景 | 观察 | 判定 |
| --- | --- | --- |
| 结构化结果重放（不同 callId） | 内容逐字一致、副作用一次 | PASS |
| waiter 取消：join 中 waiter 被 abort | waiter 得 isError(aborted) 形态，owner 不受影响，缓存正常，无重复副作用 | PASS |
| owner 取消：owner 自身 abort | owner 得 isError(aborted)，join 者正常，随后重放成功结果，无僵尸锁/无重复 | PASS |
| 提交前 abort（协作工具监听 exec.signal） | effects=0 → 重试恰好一次成功提交（effects=1） | PASS |
| 提交后 abort（先落库再等待） | 首调 isError 且 effects=1 → 重试再执行 → **effects=2** | **FAIL（unknown 缺陷复现）**：防重复副作用验收不通过 |
| Saga 补偿后缓存 | 补偿成功后同 key 请求被重放旧「created(#1)」结果（creates=1） | **FAIL（补偿一致性缺陷复现）**：补偿后结果一致性验收不通过 |

协作语义注：registry「取消不抛弃已启动的 body」；提交前 abort 只有工具主动监听
`exec.signal` 才真正中止（与官方 `dsh-tool-call-timeout-policy` 协作契约一致）。

## C3-unknown 结论与处理策略（实际复现，非推断）

**复现事实**（registry 0.1.2-rc.1，`c3-scenarios.mjs`）：工具 body 先副作用落库、再
等待且协作监听 signal；调用在提交后被 abort/超时 → 首调返回 `isError` 且 effects=1 →
本插件对 `isError` 释放锁、不缓存 → 同参数重试重新执行 → **effects=2**（重复副作用）。

**拆解**：插件把「结果不可用」一律当作 failed_safe（可重试）。但取消/超时语义是
「body 可能已提交」→ `isError/aborted` ≠ 未提交。提交后才超时/取消 = 真正的
**unknown**。本候选无法自动区分，与审计原方案 §3 的预测一致。

**处理策略结论**：
1. 现版本（0.1.x 行为线）对写操作**不承诺 exactly-once**：重试安全必须由业务侧提供
   下游幂等 key / 唯一约束 / 对账证据，插件单靠自身不可闭合。
2. 完整方案 = `succeeded / failed_safe / unknown` 状态机 + markUnknown + 对账/查询
   （审计方案 §3「新增状态与策略」），属行为升级（0.2.0 线），**本候选未实现**。
3. 现版本可执行的缓解（无需改插件）：高风险写工具配 `inFlightOnly` + 稳定业务 key，
   并让工具在提交前完成所有可能超时的等待（协作语义把 unknown 面收敛为 failed_safe）。
4. 验收口径：任何「重试安全」宣称必须附本文件 C3 复现证据 + 业务提交证据；
   **两个 E2E PASS 不能等同于「提交成功但响应丢失后重试安全」**。

## C3 Saga 补偿后缓存 — 缺口结论

补偿（cancel_order）成功后，同业务 key 再次 create_order 被重放旧「已创建」缓存
（SAGA_GAP）。插件对补偿不可见：**需要 invalidate 接口 / 操作代次 / 新业务 key**
（审计方案 §4.2 Saga 专项），本候选未提供，阶段 E 处理。

## 上游约束记录（组合轨道）

- `@why-daydream/dsh-tool-transaction@0.1.0` peer 仍为**裸地板**
  `@deepseek-ai/dsh-invariants: ">=0.0.1-rc.1"`（F1 缺陷类：只匹配 0.0.1 元组
  prerelease）→ 与 dsh-invariants 0.1.2-rc.1 **严格安装 ERESOLVE**（证据：
  npm eresolve-report 2026-09-07T03_25_53Z）。chaos/transaction 组合在 0.1.2-rc.1
  闭包上**不可构造 = 上游组合约束，非本插件不兼容**。
- `@why-daydream/dsh-chaos@0.1.1` peer 已是 per-line union（同本插件修复形态），
  仅 transaction 未修。
- 本地 dev 宿主（0.1.0-rc.5 线）上的 chaos+transaction E2E（Scenario B Saga）PASS
  （B 阶段 test:e2e 2/2）。

## C4 兼容矩阵（逐项状态）

| 轨道 | 目标 | 状态 | 证据 |
| --- | --- | --- | --- |
| 当前 latest | tools/invariants/system-prompt/llm/agent-loop/… @0.1.2-rc.1 + cordis 4.0.2 | **PARTIAL**（严格安装与 14 项回归 PASS；C3 正确性断言 4 PASS + unknown/Saga 缺陷复现 2 FAIL；Agent E2E 与组合测试未完成） | C1 baseline（calls=2）+ C2 14/14 + C3（见上）；fixture `compat/fixtures/current-latest/` |
| 上一发布线 | tools/invariants/system-prompt/llm @0.1.1-rc.2 + cordis 4.0.2 | **PASS**（本次实测） | `compat/fixtures/prev-release-0.1.1-rc.2/`：strict install EXIT 0、baseline calls=2、regression 14/14 |
| 历史基线 0.1.0-rc.8 组合 | 0.1.0 线可构造宿主闭包 | **NOT_RUN-this-session** | 未于本会话重跑；2026-09-05 PCA 记录真实安装 PASS（历史证据，不转写为本次 PASS）；peer semver 由 test:unit peer-range 28 断言覆盖。需按 §2.2 fixture 化重跑 |
| 主干前瞻 | 上游 main SHA d347e703（0.1.3-alpha.1，源码构建） | **BLOCKED-this-session** | 需隔离 checkout + 官方构建（重，非本次范围）；semver union 覆盖 0.1.3-alpha.1 ≠ 运行时证据 |
| 组合轨道 chaos/transaction | 0.1.2-rc.1 闭包 | **BLOCKED-upstream** | transaction@0.1.0 裸地板 peer → strict install ERESOLVE（上游 F1 缺陷类，非本插件）；本地 dev 宿主 Scenario B（Saga）PASS |
| Agent E2E on registry 闭包 | 基础场景（无 chaos/transaction） | **PASS**（本次实测） | `agent-e2e.mjs`：executions=1、session tool/result×2、modelRequests=3；接口差异（sessionProjections、snapshotEvents）已记录；chaos 驱动重试场景仍受上游约束 |
| 最低支持 / 非支持负例 | peer union 下界、0.2.x 排除、未来 Cordis major | **PASS**（semver 层） | test:unit peer-range.spec 28 断言 |

**矩阵结论**：两条 npm 轨道（0.1.2-rc.1 / 0.1.1-rc.2）的严格安装与 14 项幂等回归
**PASS（仅限已测范围）**；当前 latest 整体验收 **PARTIAL**——C3 已复现两个业务正确性
缺口并记为 **FAIL**（unknown 防重复副作用、Saga 补偿后一致性），Agent E2E 与组合测试
尚未在 registry 闭包完成；历史 rc.8 与主干源码轨道如实标 NOT_RUN/BLOCKED（不得用历史
PASS 顶替）。**不得以“部分通过 + 缺陷复现”宣称整体绿或重试安全。**

## 本会话改动与证据索引（C 阶段）

- 源码/测试/配置改动：`compat/acceptance/c-stage-2026-09-07.patch`（src/tests/config/docs/package.json + fixture 脚本）
- 新增自建 adapter：`tests/mock-adapter.ts`（公开 API 版，恢复 e2e 类型检查）
- fixtures：`compat/fixtures/current-latest/`、`compat/fixtures/prev-release-0.1.1-rc.2/`
  （package.json + package-lock.json 落库，node_modules 不入库）
- 验收记录：本文件 + `acceptance-b-2026-09-07.md` + `compat/acceptance/logs/`
- 运行日志：`baseline/regression/c3/agent-e2e/structured-result` 输出已在各节记录
- 本轮新增：`agent-e2e.mjs`（registry 基础 Agent E2E，PASS）、`structured-result.mjs`
  （结构化结果断言，PASS）、发布范围分析 `release-scope-2026-09-07.md`

## C3 结构化结果断言补充（registry 闭包，本轮新增）

`node structured-result.mjs`（EXIT 0）：结果字段实测为 `isError, content, value`；
`value` 存在且重放逐字一致。**表述边界（不得过度解读）**：
- `meta / additionalContexts / concludesTurn` 在本 fixture 的工具结果中**未被产生 →
  本批断言未覆盖这些字段**；不能据此证明宿主不支持这些字段，也不能证明重放对这些
  字段正确。覆盖它们需要能产出这些字段的真实 host（主干工具/Agent 结果），属后续轨道。
- 断言了**不同业务 key（r1 vs r2）不串用**结果、同 key 恒重放自身结果——这只能证明
  「按 idempotency key 的隔离」；**不构成 callId/session 身份隔离验证**（后者需验证
  缓存不得把上一调用的 callId/rootCallId/一次性上下文带到下一调用，属主干/Agent 级
  断言，本批未做）。

