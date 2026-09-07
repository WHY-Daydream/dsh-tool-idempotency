# compat/ — 可复现兼容基线

本目录按《dsh-tool-idempotency 升级方案》(2026-09-07) 阶段 A 建立。目标：任何一次
兼容核查/发布都从**冻结的版本事实**出发，而不是边查边测。

## 文件

| 文件 | 作用 |
| --- | --- |
| `targets.lock.json` | **原始冻结基线**（registry 事实 + git/环境/peerUnion/矩阵说明等静态事实）。registry 字段于 2026-09-07 02:41:40Z 解析；git 字段核对自仓库 HEAD `b6db190`。 |
| `resolve.mjs` | 只读重解析脚本。**默认不覆盖基线**：每次解析写入 `snapshots/targets-<时间>.json` 并打印与锁文件的差异；确认后显式 `--promote` 才备份旧锁并替换。 |
| `snapshots/` | 历史快照与基线备份（`--promote` 前自动备份旧 `targets.lock.json`），保留追溯依据。 |
| `fixtures/` | （待建）`compat/fixtures/<target>/package.json` + 锁文件，用真实宿主闭包 + 构建后插件 tgz 严格安装，不继承本包 devDependencies 的 `link:`。 |

## 用法

```bash
node compat/resolve.mjs --diff      # 只打印「本次解析 vs 当前锁文件」差异，不落盘
node compat/resolve.mjs --snapshot  # 另存时间戳快照 + 打印差异（默认行为）
node compat/resolve.mjs --promote   # 差异确认后：备份旧锁到 snapshots/ 再替换 targets.lock.json
```

静态事实（git HEAD、environment、peerUnion、sourceTracks、矩阵轨道说明）不在脚本
自动范围内；`--promote` 后需人工合并保留，或在锁文件头部注明 `frozenAt` 更新记录。

## 已冻结事实（2026-09-07，registry 查询 UTC 02:41:40Z）

- 插件 npm：仅 `0.1.0` / `0.1.1`，`latest=0.1.1`；源码 HEAD `b6db190` 声明 `0.1.2` —— **仓库版本 ≠ 发布版本**。
- DSH CLI `@deepseek-ai/dsh`：`latest=next=0.1.2-rc.1`、`alpha=0.1.2-alpha.5` —— latest 仍是 prerelease。
- `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-invariants`：`latest=0.0.1-rc.1`（自身标签未随 CLI 移动）、`next=0.1.2-rc.1`、`alpha=0.1.2-alpha.5`。
- cordis：`latest=4.0.2`，peer 下界 `4.0.1`。
- 本地 dev-link 宿主工作副本：`deepseek-harness` HEAD `47f9438`（0.1.0-rc.5 线，worktree 有改动）—— 不等于 npm 当前轨道。
- 上游主干 SHA `d347e703`（0.1.3-alpha.1）来自审计文档，本会话未远端复核。

## B 阶段验收口径（已修正）

测试分四档，命名不再含糊：

| 档位 | 命令 | 覆盖 |
| --- | --- | --- |
| 类型检查（src+tests） | `npm run typecheck:tests`（`tsc -b tsconfig.json`） | 源码、`tests/`（**e2e.spec.ts 除外**，见下）、vitest.config |
| 类型检查（发布面） | `npm run typecheck`（`tsc -b tsconfig.build.json`，只含 src，产出 lib） | lib 构建配置 |
| P0 专项回归 | `npm run test:p0` | `canonicalize.spec.ts` + `store-regression.spec.ts` |
| 单元完整回归 | `npm run test:unit` | `index.spec.ts` + `peer-range.spec.ts` + `canonicalize.spec.ts` + `store-regression.spec.ts` |
| E2E（依赖本地 harness 布局） | `npm run test:e2e` | `e2e.spec.ts` |
| 打包产物验收 | 见下「打包验收」 | tgz 内容、严格安装、真实入口加载 |

「全量回归」一词不使用——测试分档执行；**必须先 `npm run build` 再打包**，保证
lib/ 与 src 一致（本会话已重建并复验，见 `compat/acceptance/acceptance-b-2026-09-07.md`）。

`e2e.spec.ts` 通过相对路径 `.ts` 导入 deepseek-harness 内部
`packages/core/agent-loop/tests/mock-adapter.ts`（TS5097/TS6307），绑定本地 harness
布局，属运行时验证面（审计 P1：待阶段 C 以官方 testkit/scripted adapter 替代），
故从 tsc 类型检查排除（见 `tsconfig.json` 注释），不拖入整个 deepseek-harness 源码。

## 未完成项（后续）

- `hostClosureNpmLs`：每个宿主闭包严格安装后记录 `npm ls --all --json`（本会话的
  registry 闭包冒烟已存 `/tmp/fixture2-npm-ls.json` 并摘要进验收记录）。
- 完整兼容矩阵（§2.2 各轨道安装 + 无插件对照 + chaos/timeout/transaction 组合 +
  registry 闭包上的完整 Agent E2E）→ C 阶段。
- B 阶段核心验收已于 2026-09-07 执行并全部通过（记录见 `compat/acceptance/`）。

## 验收命令与记录（2026-09-07 已执行，退出码 0）

```bash
cd /mnt/workspace/DSH/dsh-tool-idempotency
npm run typecheck:tests   # src+单元测试类型检查（e2e 除外）；exit 0
npm run typecheck         # 发布面类型检查；exit 0
npm run build             # 从 src 重建 lib（先于打包，保证产物=已验证源码）；exit 0
npm run test:p0           # P0 专项 18/18；exit 0
npm run test:unit         # 单元完整 68/68；exit 0
npm run test:e2e          # Agent/pipeline 2/2；exit 0

# 打包验收（真实产出 tgz，再对同一份 tgz 做干净安装）：
npm pack --json           # 实际产出 tgz（--dry-run 只列清单、不产出文件，不能替代）
# 隔离目录（不继承本包 devDependencies / link:）：
npm install <同一份 tgz> <DSH 精确闭包版本…>   # strict 安装，不得 --legacy-peer-deps / omit peer
```

### 公开入口 vs 内部文件（按 `package.json#exports` 区分）

- **公开入口（消费者直接导入，必须测）**：`@why-daydream/dsh-tool-idempotency`（`.`）、
  `@why-daydream/dsh-tool-idempotency/invariant`（`./invariant`）、`./package.json`。
- **内部文件（未在 exports 公开，不得要求消费者导入）**：`canonicalize`、`stores` 等
  仅需核验：打包包含该文件（files 白名单）且主入口运行时内部加载成功——不能把它们当
  作消费者导入面测试。`exports["./src/*"]` 已在 0.1.3 修订中**移除**（原映射指向未发布
  的 src，消费者导入会 ERR_MODULE_NOT_FOUND）。

## 打包边界说明（2026-09-07 复核修订）

- `package.json#files` 已补 `lib/canonicalize.js`：`src/index.ts` → `./canonicalize.js`
  的导入在构建后必须随包发布，否则发布包加载即失败（原白名单只含 index/invariant/stores）。
- 发布前用 `npm pack --json` 的 `files` 清单复核白名单（13 项，见验收记录）；`npm run
  build` 后 `git status` 应显示 lib/ 重建差异——本会话 lib 已含 memory.ts 修复后重新
  构建，tgz SHA-256 见验收记录。

## 0.2.0 候选验收 fixture（2026-09-07）

| fixture | 宿主闭包 | 插件 | 状态 |
| --- | --- | --- | --- |
| `compat/fixtures/current-latest-0.2.0/` | registry 0.1.2-rc.1 线（cordis 4.0.2 + dsh-* 0.1.2-rc.1） | 0.2.0 候选 tgz | 归档运行验证通过；**干净安装 BLOCKED（网络，registry tarball 超时）** |
| `compat/fixtures/prev-release-0.1.1-rc.2-0.2.0/` | registry 0.1.1-rc.2 线 | 0.2.0 候选 tgz | 归档运行验证通过；**干净安装 BLOCKED（同上）** |

归档运行验证 = 复用已验收宿主闭包 + 候选 tgz 解包（等价 file: 安装内容），脚本内置
版本校验（加载版本 !== 0.2.0 即失败）。**不等于干净安装验收。**

**干净安装（网络恢复后，全新目录 `npm ci`，不复用 node_modules；同一份候选 tgz）：**

```bash
# 1) 生成/更新锁文件（仅 registry 元数据，不下载 tarball）
cd compat/fixtures/current-latest-0.2.0 && npm install --package-lock-only --no-audit --no-fund
cd compat/fixtures/prev-release-0.1.1-rc.2-0.2.0 && npm install --package-lock-only --no-audit --no-fund

# 2) 全新目录严格安装 + 全量重跑（脚本内置 [VERSION] plugin loaded = 0.2.0 校验）
cd compat/fixtures/current-latest-0.2.0 \
  && npm ci \
  && node baseline.mjs && node regression.mjs && node structured-result.mjs \
  && node c3-scenarios-0.2.0.mjs && node agent-e2e.mjs
cd compat/fixtures/prev-release-0.1.1-rc.2-0.2.0 \
  && npm ci \
  && node baseline.mjs && node regression.mjs

# 3) 归档哈希复验（发布门禁同一命令）
cd compat/acceptance && sha256sum -c tgz-0.2.0.sha256 && sha256sum -c deliverables-0.2.0.sha256
```
