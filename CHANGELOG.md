# Changelog

本项目的版本历史。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-07（验收完成，发布决策待负责人；分支 `0.2.0`）

> **状态：实现与专项测试完成（139/139 用例全绿，typecheck exit 0），已全量复验
> （2026-09-07，见 `compat/test/test-matrix.md` §9/§10）；产物未打包、未发布——
> 发布决策待负责人。** 解决 0.1.3 明确接受的两个正确性缺口（unknown 状态机、
> Saga 缓存失效）。本版**含行为变化**：不再把所有 `isError` 解释为「可以重新执行」。

### 行为变化（相对 0.1.3）

- **unknown 状态（K1 修复方向）**：无提交证据的失败（超时/abort/普通抛错/未带证据码的错误
  结果）进入 `unknown` 状态——**阻止自动重执行**，且**不随 TTL 自动解除**。重试返回结构化
  错误 `IDEMPOTENCY_STATE_UNKNOWN`（`IdempotencyStateUnknown`）。须经下游对账后
  `release`/`confirm` 解除，或改用新的操作身份（新 key）。
- **failed_safe**：工具/包装器返回带证据码 `IDEMPOTENCY_NOT_COMMITTED`
  （`error.info.code`）的错误结果时，视为「确定未提交」，释放锁且不留记录，重试允许
  重新执行。**无证据时不得凭错误码猜测提交状态**。
- 新增配置 **`maxUnknown`（默认 1024）**：unknown 墓碑的独立容量预算（墓碑永不淘汰，
  但内存有界）。预算耗尽时**新受保护执行被前置拒绝**（`IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED`，
  不淘汰旧墓碑、不让副作用在没有「失败后可记录位置」的情况下执行），对账
  `release`/`confirm` 后恢复。
- **Saga 缓存失效（K2 修复方向）**：新增 `ctx.get('toolIdempotency')` 接口——
  `query` / `release` / `confirm` / `invalidate`。
  - `invalidate(key)`：清除 succeeded 缓存并递增**代次**；旧 owner 晚到结算（owner+代次
    校验）不会把已失效结果写回。
  - `confirm(key, result)`：下游确认已提交 → 写入验证过的结果（可重放）。
  - `release(key)`：状态解除 → 后续同 key 重新执行。
  - **仅删除缓存≠可安全重执行**：补偿后需结合业务状态与新的操作身份决定后续动作。

### Fixed（相对 0.1.3 的 FAIL 复现）

- K1（unknown）：副作用已提交但响应丢失后，重试**不再盲目再次执行**（effects=2 场景
  变为重试被阻止 + 显式对账路径）。
- K2（Saga 补偿后一致性）：补偿流程可 `invalidate` 使原操作成功缓存失效，且代次机制
  防止旧执行写回陈旧结果。
- **O1（指纹碰撞）**：请求指纹 FNV-1a 32 位 → **SHA-256**（+ 规范化版本字节 `v1:`）；
  **修复 0.1.3 实测碰撞对**（`12077584`），回归实证见 `argument-equality.spec.ts`；
  碰撞概率大幅降低，但不作绝对免碰撞保证。
- **unknown 墓碑豁免容量淘汰**：`maxEntries` 只约束 succeeded 缓存，unknown 墓碑永不
  淘汰——容量压力不再静默解除防重复副作用标记（store/state-machine 补测覆盖）。
- **failed_safe 证据可来自抛错**：抛 `HarnessError(message, 'IDEMPOTENCY_NOT_COMMITTED')`
  与返回带证据码的错误结果等效（宿主保留 `error.info.code`）；无证据一律 unknown。

### 迁移注意

- 依赖「失败即重试」语义的调用方必须显式提供 `IDEMPOTENCY_NOT_COMMITTED` 证据码，或
  在重试前 `query` 状态并 `release`/`confirm`。详见 `docs/UPGRADE.md` [0.2.0]。

## [0.1.3] - 2026-09-07（发布候选，尚未发布）

> **发布状态：候选，未发布、未上 npm。** 内容 = 0.1.2 源码线的兼容 patch（未发布，
> 并入本版）+ 两个 P0 修复 + 新配置 `maxInFlight`。**不是「无运行时行为变化的兼容
> patch」**——行为变化见下。已知两个正确性缺口（FAIL 复现，见 `compat/acceptance/`
> acceptance-b/c）在本版**明确接受并显著声明**，不宣称全面防重复/重试普遍安全。

### 行为变化（相对 npm 0.1.1）

- 新增配置 **`maxInFlight`（默认 256）**：同时在途守卫执行上限。打满时**新的不同 key**
  调用返回结构化错误 `IDEMPOTENCY_CAPACITY_REJECTED`（`IdempotencyCapacityRejected`），
  不执行副作用；同 key 重试不受影响（仍 join）。高并发（>256 并发不同 key 受守卫工具）
  属新增的容量拒绝行为，升级注意见 `docs/UPGRADE.md`。
- **`maxEntries` 语义收窄**：从「总条目上限、可能淘汰执行中锁（P0 缺陷）」改为「成功
  缓存上限、只淘汰已完成项」。
- JSON 参数规范化修复（见下）会让原先被错误合并的 `__proto__` 等自有字段请求被正确
  区分——此类请求的指纹/复用行为与旧版不同（仅进程内缓存，无持久化迁移影响）。

### Fixed（P0，源码已修复并经 B/C 阶段验收）

- 执行中锁不再被缓存容量/TTL 淘汰；settle/fail 带 owner 校验，旧完成/旧失败不能
  覆盖/删除新记录；JSON 规范化保留 `__proto__`/`constructor`/`prototype` 等自有字段；
  在途容量打满显式拒绝。验收：两条 npm 轨道（0.1.2-rc.1 / 0.1.1-rc.2）14/14 幂等回归、
  基础 Agent E2E（副作用一次）、C3 正确性断言 4/4（详见 acceptance-b/c）。

### 评审修订（2026-09-07，commit 631cc44 之后，均验证通过）

- **[P1-1] abort-aware join**：join 中的 waiter 收到自身 `exec.signal` abort 时**独立退出**
  （返回由宿主映射的 isError 结果），不取消 owner、不触碰 store——实现 ARCHITECTURE §④
  「等待方收到 abort 应放弃等待」既定语义（此前实现缺失，会挂到 owner 完成）。c3 取消
  场景改用 started/joined 屏障 + 超时护栏，本地单元 + registry 闭包均 PASS。
- **[P1-2] 同 tgz 发布门禁**：发布命令改为 `npm publish ./…tgz`（已验收的同一份归档，
  禁止裸 publish 重打包）；`.github/workflows/npm-publish.yml` 同步为打包→发布同一
  tgz→registry `dist.integrity` 复验；发布后下载复验含 sha256 比对与去重冒烟。
- **[P2-3] 三态验收输出**：c3 套件输出 `PASS / KNOWN_DEFECT_REPRODUCED / FAIL`；
  Saga 场景补精确断言。最终结果 PASS=3、KNOWN_DEFECT_REPRODUCED=3（K1×2：提交后
  abort、owner 提交后取消；K2：Saga 补偿后重放）、FAIL=0。
- **[P2-4] 移除无效 exports**：删除 `exports["./src/*"]`（原指向未发布 src，消费者导入
  ERR_MODULE_NOT_FOUND）。

### 已知限制（本版接受，显著声明）

- **unknown**：副作用已提交但响应丢失/超时后，重试会再次执行（effects=2，FAIL 复现
  acceptance-c C3）。写操作不承诺 exactly-once；安全重试需下游幂等/唯一约束/对账。
- **Saga 补偿后一致性**：补偿成功后同业务 key 请求可能重放旧成功结果（FAIL 复现）。
  业务需用新 key / 主动清缓存 / 等待 TTL；invalidate/代次机制属 0.2.0。
- 内存 store：跨重启/多实例无历史去重；0.2.x 由 `<0.2.0-0` 排除。

## [0.1.2] - 2026-09-05（**未发布**，内容并入 0.1.3）

**Latest DSH compatibility fix** — 纯兼容性 patch release，无 production 行为变更
（peer 声明 + 测试适配 + regression；未改缓存算法、key 语义、TTL、FIFO、错误码）。

### Fixed

- **peerDependencies 对 DSH prerelease 版本的 npm semver 匹配**（F1）：`dsh-invariants` /
  `dsh-tools` 的裸地板 `>=0.0.1-rc.1` 只能匹配 `(0,0,1)` 元组的 prerelease；npm semver
  规则下 DSH 0.1.x 全行（0.1.0-rc.x / 0.1.1-rc.x / 0.1.2-rc.1 / 0.1.3-alpha.1）均被挡在
  门外（npm strict install 报 ERESOLVE）。改为**按已通过 PCA-07/PCA-09 验收的 prerelease
  行显式列出的 per-line union**：
  `>=0.0.1-rc.1 <0.1.0-0 || >=0.1.0-0 <0.2.0-0 || >=0.1.1-0 <0.2.0-0 || >=0.1.2-0 <0.2.0-0 || >=0.1.3-0 <0.2.0-0`
  语义：保留 0.0.1 线旧宿主兼容；覆盖 0.1.0 / 0.1.1 / 0.1.2 / 0.1.3 已测行；`0.2.x` 一律
  `<0.2.0-0` 排除。**不承诺**"所有未来 0.1.x prerelease"——新的 0.1.x tuple 必须先重跑
  compatibility acceptance 再加对应成员。
- **测试适配**（测试面，src 零影响）：
  - F2b'：`@deepseek-ai/dsh-llm` 将 call-id brand `CallId` 改名为 `ToolCallId`
    （0.1.0-rc.5 → 0.1.2-rc.1）；`tests/index.spec.ts` 改为双兼容（按链接版本取其一）
  - F2c：`JsonValue` 在 0.1.2-rc.1 不再从 `@deepseek-ai/dsh-tools` 主入口导出；
    测试改用擦除型 `never` 转换（运行时值不受影响）
  - `tests/e2e.spec.ts` 保持原样（其相对路径导入绑定本地 harness 布局，仅仓库内运行）

### Compatibility Acceptance（PCA-01 ~ PCA-10 ALL PASS）

- PCA-01 旧 peer range ERESOLVE 复现 ✅；PCA-02 新 range semver regression（28 断言）✅
- 真实 npm strict install：DSH `0.1.1-rc.2` / `0.1.2-rc.1` 干净 PASS；
  0.1.0 prerelease tuple 使用**可构造的 host 组合（rc.8）**验证 PASS —— `rc.6-only`
  组合因对应上游 package family 在 0.1.0 线内漂移而本身不可严格构造，属**上游组合约束，
  非本插件不兼容**（纯 host 对照亦 ERESOLVE）
- 0.1.2-rc.1 clean-room runtime：vitest 16/16 + idempotency golden 13/13
  （同 key 并发 join 只产生一次副作用 / 同 key 不同 arguments→`IDEMPOTENCY_KEY_MISMATCH` /
  success 重放 / failure 真重试 / TTL 过期重执行 / inFlightOnly 永不重放 / off 零假阳性 /
  FIFO 淘汰）+ invariant companion registration ✅
- consumer-symbol 三 ref audit：production 消费面无破坏 ✅；npm pack boundary 白名单
  零泄漏 + secret NONE ✅

> **PCA-10 记录（非 blocker）**：clean-room tgx smoke 阶段因本环境 registry 网络断流
> 改用 `--omit=peer` 完成打包产物加载/apply 冒烟；peer 兼容性本身已由 PCA-01 与
> PCA-04~06（strict install matrix）独立覆盖，不构成 release blocker。

### Docs

- `docs/audit/pca-complete-report.md`：完整 PCA 报告与最小 patch 依据（audit 分支）
- `docs/audit/pca07-consumer-symbol-audit.md`、`docs/compat-audit-inventory.md`
