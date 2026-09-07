# 发布候选范围分析 — 2026-09-07

目标：为「两个 P0 修复 + 最新 DSH 兼容 patch」确定可发布的候选范围与安全承诺边界。
本文只做分析与建议；最终版本号/发布与否由项目负责人定夺。

## 现状事实（全部有实测证据，见 acceptance-b / acceptance-c）

- PASS：两个 P0 修复的源码、类型、单元/P0 专项/单元完整/E2E（本地 dev 宿主）、
  tgz 严格安装、两条 npm 轨道（0.1.2-rc.1 / 0.1.1-rc.2）上 14/14 幂等回归、
  registry 闭包基础 Agent E2E（executions=1）、结构化结果重放（content+value 一致、
  显式 key 身份不串用）、C3 正确性断言 4 项。
- FAIL（缺陷复现，非「未测」）：
  1. **unknown 防重复副作用**：副作用已提交但响应丢失/超时（abort）后，重试重新执行
     → effects=2（registry 0.1.2-rc.1 实测）。
  2. **Saga 补偿后一致性**：补偿成功后同业务 key 请求被重放旧「已创建」成功结果
     （registry 0.1.2-rc.1 实测）。
- PARTIAL：当前 latest 整体验收（Agent E2E/组合在 registry 闭包部分完成；历史上限
  轨道 NOT_RUN/BLOCKED 见 acceptance-c C4）。

## 分支 A：只发布两个 P0 修复（收窄承诺的候选发布）

发布物：当前源码线（兼容 patch + P0 加固），版本号按阶段 D 门禁定（0.1.2 未发布、
可作候选基线或升 0.1.3）。

- **明确保留并在 README/CHANGELOG 声明的缺口**：
  - 写操作在「提交后响应丢失/超时」下重试可能重复副作用（unknown）；插件不承诺
    exactly-once；安全重试需下游幂等 key/唯一约束/对账。
  - 补偿（Saga）对缓存不可见；补偿后同 key 可能重放旧结果（需业务用新 key 或等待
    TTL/清缓存）。
  - 内存 store：跨重启/多实例无历史去重。
- **收窄后的安全承诺（可如实写进 README）**：
  - 在途并发 join 只执行一次副作用（P0 修复范围内）✅
  - TTL 窗口内同 key 同参数重试重放、不同参数 fail-loud ✅
  - 失败/抛错发生在副作用提交前 → 重试安全 ✅
  - **不承诺**：提交后丢响应的重试安全、补偿后一致性、跨进程 exactly-once。
- 优点：修复即达可用；缺点：文档必须显著标注边界，避免被当作全面防御。

## 分支 B：继续实现全面防御（unknown 状态机 + 补偿失效）

范围（审计方案 §3/§4.2，0.2.0 行为升级线）：
- store/引擎：`succeeded / failed_safe / unknown` 状态 + markUnknown + 对账入口；
  unknown 默认拒绝自动重执行。
- 失效机制：invalidate（业务/补偿方主动失效缓存）或操作代次（同 key 代数递增）。
- 迁移与回退说明（scope/key 语义、默认策略变化单独成版）。
- 预计额外工程日 + 需要业务侧定义对账协议；本会话未实现。

## 建议

1. **立即走分支 A 的发布候选**：两个 P0 是已验证的正确性修复，卡住不发没有收益；
   发布材料同时附 acceptance-b/c 与本文，声明边界（不宣称全面适配/重试安全）。
2. 分支 B 作为下一里程碑（0.2.0），在独立版本线实现，不塞进本候选。
3. 若负责人判定「目标必须是全面防御」，则不发布本候选、直接立项分支 B——
   但需知该选择会继续阻塞 P0 修复进入 npm（当前 npm latest=0.1.1 仍含两个 P0 缺陷）。

## 审查材料清单（代码评审入口）

| 材料 | 位置 |
| --- | --- |
| B 阶段补丁 | `compat/acceptance/b-stage-2026-09-07.patch`（1226 行） |
| C 阶段补丁 | `compat/acceptance/c-stage-2026-09-07.patch`（1822 行，待本轮新增脚本并入后重生成） |
| B 阶段验收报告 | `compat/acceptance/acceptance-b-2026-09-07.md` |
| C 阶段验收报告 | `compat/acceptance/acceptance-c-2026-09-07.md` |
| fixtures（可重放） | `compat/fixtures/current-latest/`、`prev-release-0.1.1-rc.2/`（`npm ci` + `node baseline.mjs && node regression.mjs && node c3-scenarios.mjs && node agent-e2e.mjs && node structured-result.mjs`） |
| 发布物证据 | `compat/acceptance/why-daydream-dsh-tool-idempotency-0.1.2.tgz` + `tgz.sha256` |
| 运行日志 | `compat/acceptance/logs/` |
| 依赖树 | `compat/acceptance/fixture2-npm-ls.json` |
