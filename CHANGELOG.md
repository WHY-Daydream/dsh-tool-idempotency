# Changelog

本项目的版本历史。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-09-05

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
