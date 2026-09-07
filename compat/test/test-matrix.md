# 测试矩阵与证据索引（test-matrix-0.1.3）

> 分支：`test/0.1.3-full-acceptance`；基线见 `compat/test/baseline-0.1.3.md`。
> 状态四态：**PASS**=正确性要求满足；**FAIL**=测试发现行为不符合要求；
> **BLOCKED**=因环境或依赖问题无法执行；**NOT_RUN**=尚未执行。
> 已知缺陷可单独记录「复现成功」，但业务正确性仍是 FAIL。

## 1. 已通过测试与证据索引（0.1.3 发布前验收，全部留档）

| 套件/场景 | 结果 | 数量/断言 | 证据位置 |
| --- | --- | --- | --- |
| typecheck:tests / typecheck / build（src=0.1.3） | PASS | EXIT 0 | `compat/acceptance/logs/{typecheck-tests,typecheck,build}.log` |
| test:p0（canonicalize 7 + store-regression 11） | PASS | 18/18 | `compat/acceptance/logs/test-p0.log` |
| test:unit（index 22 + peer-range 28 + p0 18） | PASS | 68/68 | `compat/acceptance/logs/test-unit.log` |
| test:e2e（Scenario A agent retry 去重 / Scenario B Saga+chaos 补偿） | PASS | 2/2 | `compat/acceptance/logs/test-e2e.log` |
| registry 0.1.2-rc.1 闭包：baseline + regression + c3 + agent-e2e + structured | PASS | 14/14 + c3 4 PASS + e2e | `compat/acceptance/acceptance-c-2026-09-07.md` §运行矩阵；`compat/fixtures/current-latest/`（npm ci 可重放） |
| registry 0.1.1-rc.2 闭包：baseline + regression | PASS | 14/14 | `compat/acceptance/acceptance-c-2026-09-07.md`；`compat/fixtures/prev-release-0.1.1-rc.2/` |
| Agent E2E（registry 闭包，无 chaos/transaction） | PASS | executions=1、tool/result×2、modelRequests=3 | `compat/fixtures/current-latest/agent-e2e.mjs`（`C2_AGENT_E2E_REGISTRY_OK`） |
| 发布后复验：registry 下载 sha256==归档、dist.integrity 一致、干净目录冒烟 | PASS | sha256 `06b6ee24…` 一致 | `compat/acceptance/release-candidate-0.1.3-2026-09-07.md`；本会话 `/tmp/dsh-postpub` 复验 |
| npm-publish CI（tag v0.1.3→bdde276） | PASS | 运行 #4 conclusion=success（跳过发布） | GitHub Actions run 34100982148 |
| peer semver 下界/0.2.x 排除/未来 major 负例 | PASS（semver 层） | 28 断言 | `tests/peer-range.spec.ts` |

## 2. 未完成项（如实标注，不用历史 PASS 顶替）

| 项 | 状态 | 原因/后续 |
| --- | --- | --- |
| 历史基线 0.1.0-rc.8 组合 | NOT_RUN（本阶段） | 需 fixture 化重跑（2026-09-05 历史安装 PASS 仅作参考，不转写） |
| DSH 主干前瞻（上游 main d347e703，0.1.3-alpha.1 源码构建） | BLOCKED | 需隔离 checkout + 官方构建（重）；semver union 已覆盖 ≠ 运行时证据 |
| transaction 组合轨道（chaos/transaction） | BLOCKED-upstream | `@why-daydream/dsh-tool-transaction@0.1.0` 裸地板 peer → strict install ERESOLVE（上游 F1 缺陷类）；本地 dev 宿主 Scenario B PASS |
| chaos 驱动的 Agent E2E 重试场景 | BLOCKED（上游约束） | registry 闭包 agent-e2e 基础场景已 PASS；chaos 注入重试仍受上游版本约束 |
| 暴露 npm token 撤销（id 16ee9e） | 收尾项（负责人官网操作） | CLI 撤销 403（2FA/策略限制），不走测试流程 |

## 3. 已知缺陷（FAIL 复现成功，业务正确性=FAIL，0.1.3 接受并声明）

| # | 缺陷 | 复现 | 影响 | 0.2.0 方向 |
| --- | --- | --- | --- | --- |
| K1 | **unknown 状态**：副作用已提交但响应丢失/超时（abort）后重试，会再次执行副作用（effects=2） | registry 0.1.2-rc.1 闭包实测 | 写操作不承诺 exactly-once | unknown 状态机 + 查询/确认接口 + 下游幂等 key |
| K2 | **Saga 补偿后一致性**：补偿成功后同业务 key 请求被重放旧「已创建」成功结果 | 实测复现 | 已失效缓存被当作业务事实 | invalidate/代次机制 + 补偿独立幂等身份 |

其余边界（已声明、未视为缺陷）：内存 store 跨重启/多实例无历史去重；结构化字段
`meta/additionalContexts/concludesTurn` 未被本批 fixture 覆盖；业务 key 隔离断言 ≠
callId/session 身份隔离验证（未做）。

## 4. 可重放命令

```bash
# 插件自带套件（本地 link 宿主）
npm run typecheck:tests && npm run typecheck && npm run build
npm run test:p0 && npm run test:unit && npm run test:e2e

# fixture 严格安装（registry 闭包，npm ci 精确重放）
cd compat/fixtures/current-latest && npm ci && node baseline.mjs && node regression.mjs && node agent-e2e.mjs
cd compat/fixtures/prev-release-0.1.1-rc.2 && npm ci && node baseline.mjs && node regression.mjs

# 归档校验（发布门禁同一命令）
cd compat/acceptance && sha256sum -c tgz-0.1.3.sha256

# 本阶段新增：业务正确性套件（见 compat/test/ 下各 .mjs/.spec.ts）
node compat/test/run-all.mjs
```

## 5. 第二阶段矩阵（业务正确性，本轮新增）

| 方向 | 必测场景 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| 请求隔离 | 相同 key 跨工具、Agent、session、工作区 | 按声明作用域隔离，不串用结果 | **PASS**（7/7，request-isolation.spec.ts） |
| 参数判等 | 特殊 JSON 字段、嵌套参数、数组顺序、模拟哈希碰撞 | 不同请求不能错误合并 | **PASS（含已知限制实证）**（9/9，argument-equality.spec.ts） |
| 取消与异常 | owner/waiter 取消、同步抛错、下游挂起 | waiter 可退出、owner 状态正确、无错误释放锁 | **PASS**（5/5，cancel-abort.spec.ts） |
| 结果重放 | value、多模态内容、实际支持的附加字段 | 保留应重放内容，不复制错误身份/一次性上下文 | **PASS**（6/6，replay-fidelity.spec.ts；meta/additionalContexts 未覆盖=NOT_RUN 附注） |
| 权限变化 | 首次允许，重试时权限被撤销 | 缓存命中不能绕过当前权限检查 | **PASS**（3/3，permission-change.spec.ts） |
| 插件生命周期 | 卸载、重新挂载、执行中卸载 | 行为明确，无重复监听和无法释放资源 | **PASS**（6/6，lifecycle.spec.ts） |
| 缓存边界 | TTL 边界、缓存满、在途满、大结果 | 不淘汰执行锁，拒绝与过期行为符合契约 | **PASS**（7/7，cache-boundary.spec.ts） |
| 业务状态变化 | 首次成功后外部修改/补偿 | 不把已失效缓存结果当作当前业务事实 | **FAIL（K2 已知限制实证）+ 缓解路径 PASS**（5/5，business-state-change.spec.ts） |

每个测试同时断言：实际副作用次数、返回结果、幂等状态、调用记录；并发用例使用
started/joined/committed 同步屏障，不依赖 sleep。

## 6. Phase 2 运行结果与观测（2026-09-07，本地 link 宿主 cordis 4.0.1 + dsh-* 0.1.0-rc.5）

套件：`tests/correctness/*.spec.ts`（8 文件，48 用例全绿），运行日志
`compat/test/logs/correctness-2026-09-07.log`；`npm run test:correctness` 可重放。
typecheck:tests（tsc -b tsconfig.json）exit 0。

| 观测 | 结论 | 影响/去向 |
| --- | --- | --- |
| O1 指纹哈希碰撞（FNV-1a 32 位） | 实测可复现碰撞对（`{"x":"s406053133"}` 与 `{"d":{"inner":967754},"z":"s428930447"}` 同指纹 `12077584`），不同请求被当作相同 → 重放首次结果 | 契约「不同请求不能错误合并」=**FAIL**（已知限制，canonicalize.ts 审计 P1 已声明，0.2.0 升 SHA-256） |
| O2 K2 实证 | 首次成功后外部补偿，同 key 重试重放旧「已创建」结果（attempts=1） | **FAIL**（已知限制，acceptance-c K2 复现的确定性用例版）；缓解路径（inFlightOnly/新 key/TTL 过期）PASS |
| O3 权限门先于 idempotency | `tools/pre-execute` + ToolGuard 在 `tools/execute`（guard 监听处）之前执行；缓存命中路径上权限检查仍执行（gateChecks 计数不减） | **PASS**：缓存命中不绕过权限检查（机制确认） |
| O4 宿主错误映射 | 本地宿主把 guard 传播的 rejection 与同步抛错映射为 `isError` 工具结果（非 promise rejection） | 观测记录：调用方以结果对象为准；waiter 取消可映射为 resolve 或 reject，套件两者均接受 |
| O5 结果物化字段 | 宿主物化结果键 = `isError/content/value`；`meta/additionalContexts` 缺失 | 重放保真限于这些字段；meta/additionalContexts 覆盖 = **NOT_RUN**（不宣称支持，与 acceptance-c 声明一致） |
| O6 explicit key 跨工具 | 同 keyArg 值跨工具 → fail-loud `IDEMPOTENCY_KEY_MISMATCH`（无串用、无静默合并） | PASS（安全隔离）；设计观察：explicit key 未按工具命名空间隔离，跨工具同值被拒绝而非各自执行 |
| O7 插件导出 | 导出面 = `Config/apply/name`，**无 invalidate/clear 接口** | 0.1.3 外部无法主动失效缓存 → 0.2.0 invalidate/代次前置事实 |
| O8 执行锁与缓存隔离 | TTL 过期不影响执行锁（owner 挂起超 TTL 仍 join）；maxEntries 压力不淘汰执行锁；maxInFlight 拒绝新 key、同 key 仍 join | PASS（P0 语义在本套件全量复验） |

