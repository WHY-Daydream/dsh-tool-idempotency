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
| transaction 组合轨道（chaos/transaction） | BLOCKED-upstream（已实证） | 严格安装 ERESOLVE 实测：transaction@0.1.0 的 peer `dsh-invariants >=0.0.1-rc.1`（0.0.1 元组）不匹配 0.1.2-rc.1 预发布（元组 0.1.2）→ npm 拒绝解析；本地 dev 宿主 Scenario B（e2e.spec.ts）PASS |
| chaos 驱动的 Agent E2E 重试场景 | PASS（基础场景）/ BLOCKED（chaos 重试注入） | registry 闭包 agent-e2e 基础场景 PASS；chaos 注入重试仍受上游版本约束；本地宿主 e2e Scenario A/B 覆盖 chaos+idempotency |
| 非支持版本运行时负例 | NOT_RUN（无已发布 0.2.x） | semver 层已由 peer-range 28 断言覆盖；0.2.x 未发布，无运行时负例可构造 |
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

## 7. Phase 3 宿主矩阵补跑与组合测试（2026-09-07）

### 7.1 宿主兼容矩阵（npm 版本线重放，fixture npm ci 精确重放）

| 目标 | 结果 | 证据 |
| --- | --- | --- |
| registry 0.1.2-rc.1 线（cordis 4.0.2 + dsh-* 0.1.2-rc.1） | **PASS** | current-latest fixture 重放：baseline OK、regression 14/14、c3（K1/K2 复现保留）、agent-e2e（executions=1）、structured OK |
| registry 0.1.1-rc.2 线（cordis 4.0.2 + dsh-* 0.1.1-rc.2） | **PASS** | prev-release fixture 重放：baseline OK、regression 14/14（注：脚本输出标签误印 0.1.2-rc.1，package-lock 实测为 0.1.1-rc.2） |
| 执行时最新 npm DSH 线 | **PASS**（= 0.1.2-rc.1 线） | npm view 实测：cordis latest=4.0.2；dsh-tools/invariants/llm/session 最新发布为 0.1.2-rc.1（latest 标签指向更旧的 0.0.1-rc.1）；dsh-agent-loop latest=0.1.0-rc.6 |
| DSH 主干源码（d347e703, 0.1.3-alpha.1） | **BLOCKED** | 需隔离 checkout + 官方构建（重）；semver union 已覆盖 ≠ 运行时证据 |
| 非支持版本（0.2.x） | **NOT_RUN**（无已发布 0.2.x） | semver 层 peer-range 28 断言 PASS；运行时负例不可构造 |

### 7.2 组合测试（本地 link 宿主，tests/correctness/combo-*.spec.ts）

| 组合 | 结果 | 关键断言/观察 |
| --- | --- | --- |
| timeout + idempotency（timeout 外层） | **PASS**（含观察） | 合作 body：提交前后超时 → 超时错误不缓存、锁释放、重试重新执行（K1 边界：响应丢失无法区分提交与否）；非合作 body → 超时不生效、调用挂起（组合契约限制：timeout 是合作式预算，需下游转发 signal） |
| timeout + idempotency（idempotency 外层） | **PASS** | owner 超时：joiner 先 join（attempts=1）共享失败；锁释放后重试重新执行 |
| bulkhead + idempotency（bulkhead 外层） | **PASS**（含组合观察） | 同 key 重试进入 bulkhead 队列而非 idempotency join（join 仅在 bulkhead 准入后可达）；队列满拒新 key（BULKHEAD_REJECTED）；槽位释放后 a2 经 idempotency 重放、新 key 执行 |
| bulkhead + idempotency（idempotency 外层） | **PASS** | 同 key 先 join（不进入 bulkhead 队列）；新 key 受 bulkhead 约束（排队/拒绝）；恢复语义正确 |
| transaction + idempotency | **BLOCKED-upstream** | 严格安装 ERESOLVE 实证（见 §2）；本地 dev 宿主 e2e Scenario B（chaos 补偿 Saga）PASS |
| 权限 + idempotency | **PASS** | Phase 2 permission-change.spec.ts：缓存命中不绕过 pre-execute/ToolGuard 权限检查 |

### 7.3 Phase 3 新增观测

| 观测 | 结论 |
| --- | --- |
| C1 bulkhead 配置契约 | `maxQueue` 必须 ≥1（0 非法）；rule 必须二选一声明 `tool` 或 `domain+tools`；`rejectWhenFull=false` 时队列满的新调用**等待**（至 queueTimeout）而非拒绝 |
| C2 组合注册顺序语义 | 两者同为 `tools/execute` 包装，先注册者在外层：bulkhead 外层 → 同 key 先排队后 join；idempotency 外层 → 同 key 直接 join。组合行为由注册顺序决定，需在部署文档中声明 |
| C3 timeout 合作式契约 | 非合作下游（不转发 exec.signal abort）下 timeout 不生效、调用挂起且执行锁被永久占用——工具必须声明并转发 signal（timeoutMs 声明的语义承诺） |

## 8. Phase 4 压力/内存/长期运行（2026-09-07，tests/correctness/stress.spec.ts，6 用例全绿）

| 负载 | 结果 | 实测证据（本机基线） |
| --- | --- | --- |
| 同 key 500 并发 | **PASS** | 副作用恰 1 次，500 waiter 全部结算且结果一致（屏障驱动） |
| 不同 key 200 并发（maxInFlight=16） | **PASS** | executed=16、capacity-rejected=184（reserve 同步裁定，无并发漏网）；槽释放后恢复 |
| 混合负载（100 执行 + 100 重放） | **PASS** | 真实执行=100（命中率 50%）；基线 200 独立=62.0ms，插件同量=68.8ms（相对 +11%，不预设毫秒阈值） |
| 大参数/大结果 | **PASS** | 2MB content 完整缓存重放（cache-boundary 套件，内存可控：8 轮 churn heap 采样 44,37,33,46,47,40,47,38 MB，无线性增长） |
| 大量 waiter 加入后取消（5 轮 × 50） | **PASS** | 全部干净退出、owner 正常结算、heap 净增长 -1.5MB（无监听器/Promise 积累） |
| 长期未完成 owner（maxInFlight=1） | **PASS** | 5 次新 key 持续容量拒绝且诊断含 `maxInFlight 1`；owner 完成即恢复 |
| 持续运行周期清空（8 轮 × 200 key） | **PASS** | 缓存上限 1024（FIFO）下 heap 收敛，无持续增长 |

性能/内存基线结论：正确性零失败；延迟相对基线 +11%（本机 node v22.22.0）；
内存无数量级积累。阈值按本机实测记录，未预先承诺毫秒数；精确泄漏检测
（--expose-gc 采样）记录为局限，宽松上界断言仅用于捕获数量级泄漏。

## 9. Phase 5 · 0.2.0 实现与验证（2026-09-07，分支 `0.2.0`）

### 9.1 实现内容（src 变更）

| 组件 | 变更 |
| --- | --- |
| `src/stores/memory.ts` | 四态模型（executing/succeeded/failed_safe 瞬态/unknown 墓碑）；代次号（invalidate/release/confirm 递增，settle/fail 校验，陈旧写回拦截）；`invalidate`/`release`/`confirm`/`query` 支撑方法；unknown 无 TTL 自动解除、FIFO 上限 maxEntries |
| `src/index.ts` | 失败分类（成功→succeeded；`IDEMPOTENCY_NOT_COMMITTED` 证据→failed_safe；其余→unknown）；unknown 阻止自动重执行（`IDEMPOTENCY_STATE_UNKNOWN`，不随 TTL 解除）；`ctx.provide('toolIdempotency')` 服务（query/release/confirm/invalidate，同名挂载守卫） |

### 9.2 验证结果（完整套件 139/139 全绿，typecheck exit 0）

> 复验日志（2026-09-07 全量重跑留档）：`compat/test/logs/full-0.2.0-verify-2026-09-07.log`
> （typecheck:tests / typecheck / build exit 0；test:p0 18/18；test:unit 69/69；
> test:correctness 68/68；test:e2e 2/2。139 = unit 69 + correctness 68 + e2e 2）。

| 方向 | 结果 | 证据 |
| --- | --- | --- |
| 既有 11 个失败语义用例迁移至新契约 | **PASS** | index.spec ×2、store-regression ×2、cancel-abort ×2、replay-fidelity ×2、combo-timeout ×2、lifecycle（provide 同名守卫） |
| failed_safe（NOT_COMMITTED 证据→重试允许） | **PASS** | state-machine-0.2.0.spec.ts |
| unknown 阻止重执行 + 不随 TTL 自动解除 | **PASS** | 同上（TTL=1 跨 1.1s 仍 blocked） |
| inFlightOnly + unknown | **PASS** | 同上 |
| query 状态转换（executing→succeeded） | **PASS** | 同上 |
| confirm(key, result) 可重放验证结果 | **PASS** | 同上（result 需完整物化形状 isError/content/value） |
| invalidate 清除缓存 + 代次防陈旧写回 | **PASS** | 同上（旧 owner 晚到结算不写回缓存） |
| 并发到达（owner 完成与失效通知先后） | **PASS** | 同上 |
| e2e Scenario A/B（chaos/transaction 本地宿主） | **PASS** | e2e.spec.ts 2/2（0.2.0 下未破坏） |

### 9.3 0.2.0 状态归位

| 项 | 0.1.3 | 0.2.0 |
| --- | --- | --- |
| K1 unknown：响应丢失后重试再次执行（effects=2） | FAIL（已知限制） | **已修复**（重试被阻止 + 对账路径）；上游写操作仍建议业务幂等 key 双重保障 |
| K2 Saga 补偿后重放旧成功结果 | FAIL（已知限制） | **已修复**（invalidate + 代次 + 新操作身份语义） |
| 单进程内存边界 | 保留 | 保留（Redis/多进程持久化不做，文档声明） |
| 其余限制 | 保留 | 保留（跨重启无历史、指纹碰撞 O1、meta/additionalContexts 未覆盖等） |

## 10. 基线复验记录（2026-09-07，分支 `0.2.0` 工作树 = 89f1624 + 未提交发布预备）

> 目的：确认基线文档声称的事实当前仍成立（「确认基线后连续推进」的落点）。
> 全部为本次实际执行结果，非转写历史 PASS。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 本机全套件（typecheck:tests / typecheck / build / p0 / unit / correctness / e2e） | **PASS**：exit 0 ×3；18/18；69/69；68/68；2/2 | `compat/test/logs/full-0.2.0-verify-2026-09-07.log` |
| fixture current-latest（registry 0.1.2-rc.1 闭包）重放 | **PASS**：baseline OK；regression 14/14；c3（PASS=3 + K1/K2 复现 3，FAIL=0）；agent-e2e executions=1 | `compat/fixtures/current-latest/`（npm ci 可重放） |
| fixture prev-release（registry 0.1.1-rc.2 闭包）重放 | **PASS**：baseline OK；regression 14/14 | `compat/fixtures/prev-release-0.1.1-rc.2/` |
| npm 0.1.3 发布产物哈希复验 | **PASS**：registry tarball sha256=`06b6ee24…` == 归档 tgz == 基线锁定值；sha512 与 dist.integrity 一致 | `baseline-0.1.3.md` §1；`npm pack @why-daydream/dsh-tool-idempotency@0.1.3` 实测 |
| GitHub Actions 实际运行复验 | **PASS**：npm-publish run #4（34100982148，head=`bdde276`，event=push，tag v0.1.3）conclusion=success | api.github.com 复查（2026-09-07） |
| 暴露 npm token 撤销（id 16ee9e） | **BLOCKED**（负责人官网操作；CLI 撤销被 403 拒绝，已实证） | `baseline-0.1.3.md` §6 |
| 组合插件提交固定 | **PASS**（本次补记） | chaos `01130b5`、transaction `3cb9391`、bulkhead `c134237`、deepseek-harness `47f943859b`（见 baseline-0.1.3.md §2） |




