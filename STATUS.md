# dsh-tool-idempotency 状态记录

> 更新：2026-08-17。记录已完成与未完成事项，供后续会话与协作追溯。

## 一、套件总览（DSH Reliability Suite）

| 插件 | 定位 | 状态 |
|---|---|---|
| `dsh-chaos` | 故障注入 | ✅ 已发布 npm 0.1.0 + GitHub Release v0.1.0（2026-08-16 封板） |
| `dsh-tool-transaction` | Saga 补偿 | ✅ 已发布 npm 0.1.0 + GitHub Release v0.1.0（2026-08-16 封板） |
| `dsh-tool-idempotency` | 幂等 / 重复副作用防御 | 🚧 MVP 已实现（未发布） |

完整链路：**Fault Injection → Duplicate Prevention → Compensation**。

## 二、dsh-tool-idempotency 已完成

| # | 事项 | 证据 / 位置 |
|---|---|---|
| 1 | 命名统一 `dsh-tool-idempotency`（仓库 + npm 名均可用） | GitHub 0 同名仓库；npm registry 404 |
| 2 | 生态扫描撞车分析（2026-08-16） | 官方相邻 `dsh-repeat-tool-reminder`（advisory，可差异化）；`dsh-session-checkpoint-policy` 已占 Recovery 方向（放弃方向 3） |
| 3 | ARCHITECTURE.md 设计规格（问题边界 / 幂等模型 / 状态机 / pipeline 接入 / 存储抽象 / 危险场景） | ARCHITECTURE.md |
| 4 | 包骨架（对齐 dsh-tool-transaction 发布形态） | package.json / tsconfig 三件套 / vitest.config.ts / cordis.patch.yml |
| 5 | 核心实现：Config + apply + MemoryStore + invariant companion | src/index.ts、src/stores/memory.ts、src/invariant.ts |
| 6 | pipeline 接入（`tools/execute` 主拦截） | 缓存复用 / in-flight 并发加入 / `IDEMPOTENCY_KEY_MISMATCH` fail-loud / TTL / `inFlightOnly` |
| 7 | 单元测试 **16/16**（vitest 4.1） | tests/index.spec.ts |
| 8 | 验证全绿：oxlint 0 告警 / tsc 0 错误 | 2026-08-17 实测 |
| 9 | E2E 设计（场景 A：chaos timeout→retry→幂等复用；场景 B：transaction 补偿兜底） | ARCHITECTURE.md「E2E 设计」 |
| 10 | 提交并推送 main（`42dbd84`，无 Co-Authored-By） | GitHub 远程已验证 |
| 11 | **E2E 实现（2/2 通过）** | tests/e2e.spec.ts：场景 A 用 chaos seed=9 使首调 TOOL_TIMEOUT、重试复用（副作用恰 1 次）；场景 B 复合 Saga 工具经 `ctx.tools.execute` 嵌套调度，chaos HTTP_500 触发逆序补偿 → `ROLLED_BACK` |
| 12 | **发布链：tag v0.1.0 + GitHub Release v0.1.0** | tag 已推（`f8a0389`）；Release id 371672495 已公开（2026-08-17 API 复验 200）；npm 上架复验中（npmmirror/unpkg/jsdelivr 暂 404，疑同步延迟） |

## 三、未完成（按优先级）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **npm 0.1.0 上架确认** | 用户已在联网机器执行发布；本环境各镜像复验暂 404（同步延迟或发布未成功），需用户回执 `npm publish` 输出确认 |
| 2 | **v1.1 推迟项** | `ctx.idempotency` 服务 API；post-execute 模型可见复用提示（需 dsh-llm / dsh-session 依赖） |
| 3 | **仓库 polish** | 三个仓库补 description + 打 `dsh-plugin` topic（`gh repo edit`，需用户 GitHub 认证执行） |
| 4 | **Show Your Plugins! 投稿** | 文案已备（中英双语），待用户发布到官方讨论区 |

## 四、纪律记录

- 提交信息**不带 Co-Authored-By**（用户明确偏好，已全局记忆）
- 已发布历史（dsh-chaos / dsh-tool-transaction）**不做 rewrite**
- 本地开发依赖 `link:../deepseek-harness/...`（vendor/cordis、packages/core/tools、packages/llm/llm、packages/core/system-prompt、packages/runtime-diagnostics/invariants）
