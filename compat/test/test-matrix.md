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
| 参数判等 | 特殊 JSON 字段、嵌套参数、数组顺序、模拟哈希碰撞 | 不同请求不能错误合并 | **PASS（O1 已修复，见 §11.3）**（9/9，argument-equality.spec.ts） |
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
| O1 指纹哈希碰撞（FNV-1a 32 位） | 实测可复现碰撞对（`{"x":"s406053133"}` 与 `{"d":{"inner":967754},"z":"s428930447"}` 同指纹 `12077584`），不同请求被当作相同 → 重放首次结果 | 契约「不同请求不能错误合并」=**FAIL**（0.1.3 已知限制）；**0.2.0 已修复**：SHA-256 + `v1:` 版本字节，回归实证见 §11.3 |
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
| 其余限制 | 保留 | 保留（跨重启无历史、meta/additionalContexts 未覆盖等；**O1 指纹碰撞已修复**，见 §11.3） |

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
| 分支推送 origin（0.2.0 / test/0.1.3-full-acceptance） | **BLOCKED**（环境/认证） | SSH publickey denied（`github-ssh/id_ed25519` 被 GitHub 拒绝，无 GitHub https token）；提交已本地落地（`dce90ba`），推送待负责人重新配置认证 |

## 11. 0.2.0 候选包验收（2026-09-07，分支 `0.2.0`）

> 本轮按负责人审阅意见执行：打包 0.2.0 候选 tgz → 隔离 fixture 确认实际加载版本 → 重跑；
> K1/K2 用真实 pipeline 复现脚本验证业务结果已改变；O1 单独记录处理状态；
> 组合/负载补齐显式参数。**发布决策仍待负责人，本阶段只做候选验收。**
>
> **验收口径（2026-09-07 修订）**：本阶段完成的是「**归档运行验证通过**」（复用已验收
> 宿主闭包 + 候选 tgz 解包 + 脚本版本校验）；「**干净安装验收**」（全新目录 `npm ci`
> 同一份候选 tgz）因 registry tarball 下载超时 **BLOCKED-网络**——两者分开记账，
> 不再使用「发布包级验收完成」表述。

### 11.1 候选包与隔离 fixture

| 项 | 值 |
| --- | --- |
| 候选 tgz | `compat/acceptance/why-daydream-dsh-tool-idempotency-0.2.0.tgz`（18554 B） |
| sha256 | `26e0abd58bd44ce1540fdb664260b1a7277900d6879245a1ab11cecaa84be47c`（`tgz-0.2.0.sha256`，发布门禁同一命令 `sha256sum -c`） |
| 归档内部 name/version | `@why-daydream/dsh-tool-idempotency` / `0.2.0`（tar 读 package/package.json 实测） |
| 隔离 fixture（0.1.2-rc.1 线） | `compat/fixtures/current-latest-0.2.0/`：cordis 4.0.2 + dsh-* 0.1.2-rc.1 + 0.2.0 候选 tgz；脚本核对实际加载版本 === 0.2.0 |
| 隔离 fixture（0.1.1-rc.2 线） | `compat/fixtures/prev-release-0.1.1-rc.2-0.2.0/`：0.2.0 候选包 × 上一发布线；脚本核对加载版本 === 0.2.0 |
| 0.1.3 对照 | `compat/fixtures/current-latest/`（0.1.3 tgz 闭包，未改动） |
| 干净安装 | **BLOCKED-网络**（registry tarball 下载超时；命令与重放步骤见 `compat/README.md`，网络恢复后 `npm install --package-lock-only` + 全新目录 `npm ci`） |

**归档运行结果（0.2.0 候选，全部实际执行；脚本内 `[VERSION] plugin loaded = 0.2.0`）**

| 脚本 | 0.1.2-rc.1 线 | 0.1.1-rc.2 线 |
| --- | --- | --- |
| baseline.mjs（无插件对照） | **PASS** | **PASS** |
| regression.mjs | **PASS 14/14**（1 例按 0.2.0 契约改写） | **PASS 14/14**（同） |
| structured-result.mjs | **PASS**（value 一致；meta/additionalContexts/concludesTurn UNCOVERED） | — |
| c3-scenarios-0.2.0.mjs | **PASS 7/7** | — |
| agent-e2e.mjs | **PASS**（executions=1） | — |

**K1/K2 A/B 对照（同一 pipeline 复现脚本族，业务结果已改变）**

| 场景 | 0.1.3 候选（对照 fixture） | 0.2.0 候选 |
| --- | --- | --- |
| 提交后 abort（副作用已执行、响应丢失） | `KNOWN_DEFECT K1`：重试自动重执行 **effects=2** | **修复**：重试返回 `IDEMPOTENCY_STATE_UNKNOWN`，effects 不增；`release` 对账后才重新执行 |
| Saga 补偿后同 key 重发 | `KNOWN_DEFECT K2`：重放旧「已创建」结果（creates=1） | **修复**：`invalidate` 后重新执行（creates=2）并观察到**新业务状态**（`recreated (#2) after compensation`） |
| 带 NOT_COMMITTED 证据的失败 | 同普通错误（不区分） | failed_safe：无墓碑，重试直接重新执行（attempts=2） |
| unknown → confirm 验证结果 | 无此路径 | 重放验证结果，不重执行 |

> fixture `package-lock.json` 生成受网络阻塞（registry tarball 下载超时，元数据可用）；
> node_modules 复用已验收闭包 + 候选 tgz 解包（等价 file: 安装内容），脚本版本校验保证
> 加载即 0.2.0。锁文件待网络恢复后 `npm install --package-lock-only` 补生成（**BLOCKED-网络**）。

### 11.2 unknown 五要点验证（对照验收标准逐条，PASS）

| 验收要点 | 结果 | 证据 |
| --- | --- | --- |
| 提交后失败进入 unknown，重试不新增副作用 | **PASS** | state-machine（TTL=1 跨 1.1s 仍 blocked）+ c3-0.2.0 K1（effects 不增） |
| 确认未提交后，才允许重新执行 | **PASS** | 新增 release 用例（state-machine + store 层）+ c3-0.2.0 release 路径 |
| 确认已提交后，提供正确结果或明确状态 | **PASS** | confirm 用例（重放验证结果）+ c3-0.2.0 confirm 路径 |
| unknown 不因 TTL、容量淘汰、旧 owner 回写意外解除 | **PASS**（含本轮修复） | TTL 用例；**新增墓碑豁免容量淘汰**（store 层 5 墓碑 > maxEntries=2 全保留）；新增陈旧 owner fail 不写回；代次校验 |
| Saga 失效与原操作完成并发时，旧结果不重新进入缓存 | **PASS** | 代次保护 2 用例（失效先/后到达两序） |

### 11.3 O1 指纹碰撞处理状态（单独记录）

| 项 | 0.1.3 | 0.2.0 |
| --- | --- | --- |
| 指纹算法 | FNV-1a 32 位（实测碰撞对 `12077584` → 不同请求被错误合并，**FAIL 复现**） | **升级 SHA-256 + 规范化版本字节 `v1:`**（node:crypto 内建，无新增依赖）；**修复已知 FNV 碰撞对**，碰撞概率大幅降低但**不作绝对免碰撞保证**（任何哈希均有理论碰撞可能，契约以实测碰撞对回归为准） |
| 回归证据 | argument-equality「已知限制实证」断言 attempts=1 | 同一用例**翻转为修复实证**：attempts=2、结果各自独立、可分别重放；canonicalize.spec 新增碰撞对回归 |
| 状态 | FAIL（核心正确性缺陷，曾被「全部测试通过」掩盖） | **PASS（已修复已知碰撞对）**；进程内缓存，无持久化迁移影响 |
| 文档 | audit P1「计划升级 SHA-256」 | UPGRADE.md §5 / CHANGELOG [0.2.0] 记录 |

### 11.4 组合与压力测试显式参数（已测范围如实声明）

**已测宿主**：① 本地 link（cordis 4.0.1 + dsh-* 0.1.0-rc.5）全套件；② registry 0.1.2-rc.1 闭包 fixture；③ registry 0.1.1-rc.2 闭包 fixture；④ 0.2.0 候选 fixture（registry 0.1.2-rc.1 闭包）。

**已测组合**（tests/correctness/combo-*.spec.ts + e2e，本地宿主）：timeout×idempotency（两注册序）、bulkhead×idempotency（两注册序）、权限×idempotency、chaos×idempotency（e2e Scenario A/B）；transaction×idempotency **BLOCKED-upstream**（peer ERESOLVE 实证，本地宿主 e2e Scenario B 覆盖补偿流程）。

**压力参数与指标**（tests/correctness/stress.spec.ts，屏障驱动确定性并发，非 sleep 猜测）：

| 负载 | 参数 | 观测 |
| --- | --- | --- |
| 同 key 大量并发 | 500 并发 | 副作用恰 1 次，500 waiter 全部结算 |
| 不同 key 大量并发 | 200 并发、maxInFlight=16 | executed=16、capacity-rejected=184，槽释放后恢复 |
| 混合负载 | 100 执行 + 100 重放 | 真实执行=100；本机基线 61.0ms vs 插件 67.7ms（+11% 相对，不预设毫秒阈值） |
| 大参数/大结果 | 2MB content | 完整缓存重放，内存可控 |
| waiter 取消 | 5 轮 × 50 | 全部干净退出，heap 净增长 −2.1MB（宽松上界） |
| 长期未完成 owner | maxInFlight=1，5 次新 key | 持续容量拒绝且诊断含 `maxInFlight 1`，owner 完成即恢复 |
| 持续运行周期清空 | 8 轮 × 200 新 key churn（FIFO 1024） | heap 采样收敛（44,38,34,47,48,49,48,47 MB），无线性增长 |

**诚实声明**：现有压力为秒级确定性并发 + 相对内存采样；2026-09-07 已补 **150 秒长时负载
（`--expose-gc`，见 §12.3）**；**小时级连续运行与精确泄漏判定仍 NOT_RUN**（宽松上界
仅捕获数量级泄漏，`--expose-gc` 只是辅助观测，不单独证明无泄漏）。

### 11.5 semver 0.2.x 拒绝范围（宿主澄清）

- **“0.2.x 尚未发布”指 DSH 宿主**（`@deepseek-ai/dsh` 等 0.2.x 未发布，`targets.lock.json`
  冻结事实），非本插件。
- peer 联合范围对宿主 0.2.x **拒绝**：`tests/peer-range.spec.ts` 28 断言覆盖
  `0.2.0` / `0.2.0-alpha.1` 不满足（`<0.2.0-0` 封顶每个成员）；**semver 层拒绝测试已执行**。
- 运行时负例（装宿主 0.2.x 跑插件）在宿主 0.2.x 发布前不可构造 → **NOT_RUN**，不阻塞
  semver 拒绝范围测试结论。

### 11.6 本轮改动清单

- 代码：`src/canonicalize.ts`（SHA-256 + `v1:` 版本字节）；`src/stores/memory.ts`（墓碑
  豁免容量淘汰、fail() 识别 NOT_COMMITTED 证据）；`src/index.ts`（Config 注释）。
- 测试：canonicalize.spec（碰撞对回归）；argument-equality.spec（O1 实证翻转）；
  state-machine-0.2.0.spec（+4：release 路径、容量豁免、陈旧 owner、抛错证据）；
  store-regression.spec（+3 store 层契约）。
- 候选产物：0.2.0 tgz + sha256；fixture `current-latest-0.2.0`（版本校验注入 + c3 新契约）。
- 文档：UPGRADE.md §5、CHANGELOG [0.2.0]、本矩阵 §11。

## 12. 第二轮候选验收补测（2026-09-07，分支 `0.2.0`）

> 按负责人第二轮审阅意见补齐：墓碑容量预算（内存有界）、release/confirm 业务账本证据、
> 干净安装口径拆分、长时负载与资源释放。

### 12.1 unknown 墓碑容量预算（maxUnknown）

| 项 | 设计/证据 |
| --- | --- |
| 配置 | 新增 `maxUnknown`（默认 1024，独立于 `maxEntries`）：墓碑**永不淘汰**但**有独立预算**——内存有界且不静默解除防重复副作用标记 |
| 满载行为 | 预算耗尽时**前置拒绝**新受保护执行（新错误码 `IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED` / `IdempotencyUnknownCapacityRejected`）：不淘汰旧墓碑，也不让副作用在没有「失败后可记录位置」的情况下执行；**同 key 历史 unknown 不被绕过**（重试仍 `STATE_UNKNOWN`） |
| 恢复 | 对账 `release`/`confirm` 释放预算；`invalidate` 不影响墓碑（补偿只管 succeeded 缓存） |
| 测试 | store 层 +2（预算拒绝/恢复、`maxUnknown` 非正校验）；pipeline 层 +1（前置拒绝→对账→恢复，attempts 断言副作用未执行）；相关套件 52/52 全绿 |

### 12.2 对账决策核对业务账本（release/confirm 业务证据）

| 对账结果 | 后续动作 | 测试证据 |
| --- | --- | --- |
| 已提交成功 | `confirm` 正确结果 → 重试重放，账本不新增 | state-machine 账本用例：ledger 恰一条、attempts=1；c3-0.2.0「对账=已提交」场景 |
| 确认未提交 / 已完成可靠补偿 | 才允许 `release` → 重新执行 | state-machine 账本用例：ledger 空→release→恰新增一条；c3-0.2.0「对账=未提交」场景（effects=2、ledger 仅 `commit-2`） |
| 仍无法确定 | 保持 unknown，重试持续被阻止 | state-machine 账本用例（attempts 恒 1） |

修正说明：0.2.0 首轮 c3 K1 场景以 `release` 结束（副作用已提交场景），本轮按负责人
意见改为**账本核对后 `confirm`**——「提交后 abort」业务事实=已提交，`release` 会引入
重复副作用；测试必须检查业务账本，不能只验证 release 后工具可再次运行。

### 12.3 长时负载与资源释放（`--expose-gc`，150 秒，本地 link 宿主）

运行：`node --expose-gc compat/stress/long-run.mjs 150`；日志
`compat/test/logs/long-run-0.2.0-2026-09-07.log`。

| 负载/指标 | 实测 |
| --- | --- |
| 时长 / 周期 | 150.0s / 2084 周期（每周期：100 成功 key + 100 unknown key + 并发 join/取消） |
| 成功 key 去重 | 执行 41800 / 重放 41800，**零重复**（每个 key 恰执行 1 次） |
| unknown 容量强制 | unknown 执行 13826、重试被阻止 13825；**满载前置拒绝 361175 次**；墓碑全程封顶 `maxUnknown=64` |
| 对账恢复 | release 13409 + confirm 417；恢复后新 key 可执行 |
| 并发 join/取消 | joined 14588、cancelled 4168、owner 执行 417（监听器不积累，无挂起） |
| 内存（gc 后采样） | start 6MB → end 13MB（净增 +7MB）；采样 7–13MB 波动，unknown 恒 ≤64；后半段均值不高于前半段 >8MB 上界 |
| 结论 | **ALL PASS**（正确性零失败；内存有界，无线性增长） |

诚实声明：150 秒确定性负载 + gc 采样通过；**小时级连续运行与精确泄漏判定仍 NOT_RUN**
（宽松上界仅捕获数量级泄漏；`--expose-gc` 为辅助观测，不单独证明无泄漏）。

### 12.4 干净安装口径（与 §11.1 一致）

- 本阶段 = **归档运行验证通过**（复用已验收宿主闭包 + 候选 tgz 解包 + 脚本版本校验）；
  **干净安装验收 BLOCKED-网络**（registry tarball 下载超时）。
- 上一发布线（0.1.1-rc.2）**0.2.0 候选包**归档运行：baseline OK、regression 14/14
  （`compat/fixtures/prev-release-0.1.1-rc.2-0.2.0/`，版本校验已注入）。
- 网络恢复后命令与步骤：`compat/README.md`「0.2.0 候选验收 fixture」。




