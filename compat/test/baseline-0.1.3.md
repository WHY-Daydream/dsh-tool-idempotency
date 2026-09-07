# 0.1.3 测试基线（baseline-0.1.3）

> 分支：`test/0.1.3-full-acceptance`（自 `v0.1.3` 标签创建，HEAD=`bdde276`）
> 目的：固定「插件产物 + DSH 宿主 + 依赖 + 环境」四要素，保证后续测试可重放、可对照。

## 1. 插件产物固定点

| 项 | 值 |
| --- | --- |
| npm 包 | `@why-daydream/dsh-tool-idempotency@0.1.3`（dist-tags `latest=0.1.3`） |
| 归档 sha256 | `06b6ee245fe5b8ec838f80f90883f7ce2b0c5acf9219c51f273b32a3ecf41fb0` |
| 归档 sha512-integrity | `sha512-S0Z5S5OKiTNlOzowdEFlXL7/pMPtsbJEvOrrF0MXGm7lrkTuLTiE3PrQbkJaoqy0rukKPiQQfLrnLYA+w5PegQ==`（= registry `dist.integrity`） |
| 归档路径 | `compat/acceptance/why-daydream-dsh-tool-idempotency-0.1.3.tgz` |
| 校验文件 | `compat/acceptance/tgz-0.1.3.sha256`（`cd compat/acceptance && sha256sum -c`） |
| 发布内容提交 | `e224263`（归档内部 name/version 比对门禁所在提交，发布字节以此为准） |
| 分支/tag | `v0.1.3` → `bdde276`（= e224263 + `ba2b286` 发布记录 + `bdde276` CI 跳过发布门禁） |
| CI 门禁 | `.github/workflows/npm-publish.yml`：sha256 校验 → 归档内部 name/version 比对 → tag==版本 → registry 同版本且 integrity 一致则跳过发布 → 发布后 integrity 复验 |

## 2. DSH 宿主版本线（三条）

| 线 | 版本 | fixture/来源 | 说明 |
| --- | --- | --- | --- |
| 本地 link（devDeps） | cordis `4.0.1`；dsh-agent / agent-loop / agent-loop-testkit / invariants / llm / session / system-prompt / timeout-policy / tools `0.1.0-rc.5` | `../deepseek-harness/*`（link:） | 开发宿主；与 npm 最新版≠运行时证据 |
| registry 0.1.2-rc.1 线 | cordis `4.0.2`；dsh-tools / invariants / system-prompt / session / llm / agent-loop / agent-loop-testkit / timeout-policy `0.1.2-rc.1` | `compat/fixtures/current-latest/`（npm ci + `package-lock.json`） | 已测两条 npm 版本线之一 |
| registry 0.1.1-rc.2 线 | cordis `4.0.1`；dsh-* `0.1.1-rc.2` | `compat/fixtures/prev-release-0.1.1-rc.2/`（npm ci + `package-lock.json`） | 已测两条 npm 版本线之二 |

组合插件（本地 link，提交已固定）：`@why-daydream/dsh-chaos` `0.1.0`（git `01130b5`）、
`@why-daydream/dsh-tool-transaction` `0.1.0`（git `3cb9391`）、
`@why-daydream/dsh-tool-bulkhead` `0.1.1`（git `c134237`）；
DSH 主干工作副本 `deepseek-harness@47f943859b`（0.1.0-rc.5 线，见 `targets.lock.json` sourceTracks）。

## 3. 依赖锁文件

| 文件 | sha256 | 状态 |
| --- | --- | --- |
| `pnpm-lock.yaml` | `2a1d8f0f13d2b2bca95955b195460038725a2ec959a7ac065546bc02893eb989` | 已入库（`git ls-files` 确认） |
| `compat/fixtures/current-latest/package-lock.json` | 16504 B（9月7日 13:30） | 已入库（fixture 用 `npm ci` 重放） |
| `compat/fixtures/prev-release-0.1.1-rc.2/package-lock.json` | 11266 B（9月7日 13:34） | 已入库 |

## 4. 测试环境

| 项 | 值 |
| --- | --- |
| node | v22.22.0 |
| npm | 10.9.4 |
| OS/arch | linux x86_64 |
| 包管理器 | npm（fixture 严格安装）+ pnpm（根锁文件） |
| 测试框架 | vitest ^4.1.8；typecheck `tsc -b`（typescript ^6.0.3） |

## 5. 可重放命令

```bash
# 插件自带套件（本地 link 宿主）
npm run typecheck:tests && npm run typecheck && npm run build
npm run test:p0 && npm run test:unit && npm run test:e2e

# fixture 严格安装（registry 闭包，npm ci 精确重放）
cd compat/fixtures/current-latest && npm ci && node baseline.mjs && node regression.mjs && node agent-e2e.mjs
cd compat/fixtures/prev-release-0.1.1-rc.2 && npm ci && node baseline.mjs && node regression.mjs

# 归档校验（发布门禁同一命令）
cd compat/acceptance && sha256sum -c tgz-0.1.3.sha256
```

## 6. 环境与收尾事实

- **GitHub Actions 实际运行**：tag `v0.1.3` 推送触发的 npm-publish 运行 #4（`bdde276`）**conclusion=success**；registry-check 命中「同版本且 integrity 一致 → 跳过发布」，未再 E403。工作流其余运行：无其他成功记录（早期尝试见 runs 列表）。
- **暴露 token 撤销**：id `16ee9e`（`npm_JaAA…6uw8`）CLI 撤销被 npm 403（2FA/策略限制），由负责人在 npmjs.com → Settings → Access Tokens 官网撤销（独立收尾项，不阻塞测试）。
- **已知未执行项（如实标 NOT_RUN/BLOCKED，不用历史 PASS 顶替）**：历史 0.1.0-rc.8 组合、DSH 主干前瞻源码构建、transaction 组合（peer ERESOLVE 上游缺陷）、chaos 驱动的 Agent E2E 重试场景——详见 `test-matrix.md`。
