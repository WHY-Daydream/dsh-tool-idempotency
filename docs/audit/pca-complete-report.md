# dsh-tool-idempotency — Latest-DSH Compatibility Audit 报告（PCA-01 ~ PCA-10）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `7aab1b9`，published **v0.1.1**）
**状态**: **audit-first 完成，未改 production、未发布**。复用 chaos/bulkhead PCA 模板。
**铁律遵守**: 无 `--force` / `--legacy-peer-deps`；能安装 ≠ 能注册 ≠ 幂等语义没变；
发现 breaking 先报告，不用 peer range 掩盖。

## 结论速览

| 问题 | 结论 |
|---|---|
| 当前 peer bug 是否真实存在 | ✅ 是（PCA-01 实证：2× ERESOLVE） |
| 候选 union | ✅ PCA-02 草稿（ALL PASS，见下） |
| 最新 DSH API 是否 breaking | ❌ production 无破坏；3 处**测试面** drift（F2b'/F2c/F2e'，见下） |
| runtime golden path 是否 PASS | ✅ PCA-08/09 全绿（clean-room vitest 16/16 + golden 13/13 + companion 注册） |
| 最小 patch scope | peer union（2 peer）+ index.spec 测试适配 + semver regression + CHANGELOG |
| 是否允许进入 compatibility patch release | ✅ 允许（无 runtime breaking；**下个版本为 v0.1.2**，当前已 0.1.1） |

## PCA 汇总

| Gate | 内容 | 结果 | 证据 |
|---|---|---|---|
| PCA-01 | 已发布 peer range ERESOLVE 复现 | ✅ | npm strict exit 1，2× ERESOLVE（`/tmp/ipca01/install.log`；首冲突 `peer dsh-invariants ">=0.0.1-rc.1" from idempotency@0.1.1`） |
| PCA-02 | 候选 per-line union semver regression | ✅ ALL PASS | `/tmp/ipca02-semver.mjs`（全部已发布版本 + 0.1.3-alpha.1 in-window；0.2.x out） |
| PCA-03 | 旧开发基线 typecheck + vitest | ✅ | tsc exit 0 + vitest 18/18（index 16 + e2e 2；基线版本见 inventory：cordis 4.0.1、dsh-* 0.1.0-rc.5） |
| PCA-04/05/06 | 真实 npm strict 安装矩阵 | ✅ | `/tmp/ipca45/`：0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.0-line(rc.8 全闭包) 均 INSTALL OK |
| PCA-07 | consumer-symbol audit（三 ref） | ✅ 无破坏 | `docs/audit/pca07-consumer-symbol-audit.md` |
| PCA-08 | 真实 0.1.2-rc.1 clean-room load/apply/注册 | ✅ | `/tmp/ipca08`：vitest 16/16（真实运行时）+ src+tests typecheck exit 0 + src-only exit 0 + companion 注册 PASS |
| PCA-09 | idempotency 专属 runtime golden | ✅ 13/13 | `/tmp/ipca08/pca09-golden.mjs`（7 场景全 PASS） |
| PCA-10 | typecheck + vitest + pack boundary + secret + clean-room tgz | ✅ | 见下 |

## PCA-02 候选 union（草稿；批准后才落入 package.json）

| peer | 已发布地板 | 候选 |
|---|---|---|
| @deepseek-ai/dsh-invariants | `>=0.0.1-rc.1` | `>=0.0.1-rc.1 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0` |
| @deepseek-ai/dsh-tools | `>=0.0.1-rc.1` | 同上 |
| @deepseek-ai/cordis | `>=4.0.1` | 不变（stable 线） |

仅覆盖 PCA-07/09 已验证 tuple；0.2.x 一律 `<0.2.0-0`；未来 0.1.4+ 须重跑验收再加成员。

## Findings

- **F1（阻塞发布）**：peer 地板 `>=0.0.1-rc.1`（tuple (0,0,1)）不匹配任何 0.1.x prerelease 行 →
  npm strict ERESOLVE（PCA-01 实证；与 chaos/bulkhead 同款）。修复 = 候选 union。
- **F2b'（测试面 drift，同 chaos F2 / bulkhead F2b）**：dsh-llm brand `CallId → ToolCallId` →
  `tests/index.spec.ts` 导入需双兼容适配。production src 零影响。
- **F2c（测试面 drift，同 bulkhead）**：dsh-tools `JsonValue` 在 0.1.2-rc.1 主入口无导出 →
  测试用擦除型 cast。production src 零影响。
- **F2e'（E2E 测试面，harness 布局绑定）**：`tests/e2e.spec.ts` 第 26 行
  `import { MockAdapter, … } from '../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'`
  ——相对路径直指本地 harness 源码树（agent-loop 内部测试设施，未发布），E2E 只能在仓库原布局
  运行（基线 18/18 已验证），**无法进独立 clean-room**；属测试面限制，不影响 patch 判定。
- **fail-loud 契约（实证）**：`apply()` 对 raw config 做 `ttl`/`maxEntries` ≥1 整数校验
  （schema 默认值由 `ctx.plugin()` 挂载时应用）；clean-room tgz 冒烟曾因直调 `apply()`
  传空 config 触发该校验——**插件行为符合设计**，非缺陷。

## PCA-09 golden 明细（真实 0.1.2-rc.1 clean-room，13/13 PASS）

A 并发同 key → join in-flight（副作用恰一次）✅ · B 同 key 不同 arguments →
`IDEMPOTENCY_KEY_MISMATCH`（executing 态）✅ · C succeeded + reuse → 重放缓存 ✅ ·
D failed → 删除、retry 真重执行 ✅ · E TTL 1s 过期 → 重新执行 ✅ ·
F inFlightOnly 永不重放 + mode off 零假阳性 ✅ · G FIFO maxEntries=1 淘汰 → 重执行 ✅

## PCA-10 明细

- baseline typecheck exit 0 + vitest 18/18 ✅
- `why-daydream-dsh-tool-idempotency-0.1.1.tgz`：全部在白名单内、secret NONE；
  shasum `f64cca7da4e7f8d0fa44d33baf2a9204f9c64b63`、integrity `sha512-6+WZaQeEVYFDeAej2UGVYglgSsSrKgxdCIDBFyl61fSpwDExYZGXK5ofpQFO2Ol19ySfDAiPD3hydH3r/ewJpQ==`
- clean-room tgz 冒烟 PASS：打包产物可加载（exports Config/apply/name）、apply 注册
  `tools/execute`、invariant 子路径可用。注：严格安装环节受 registry 网络断流影响改用
  `--omit=peer`（peer 兼容性由 PCA-01/04-06/7 独立覆盖，非 blocker）。

## 最小 patch scope（未实施；待用户批准后按 chaos/bulkhead v0.1.1 流程发 **v0.1.2**）
1. `package.json`：dsh-invariants / dsh-tools 换候选 union（cordis 不变）；version 0.1.1 → 0.1.2
2. `tests/index.spec.ts`：F2b' 双兼容（CallId→ToolCallId 按链接取其一）+ F2c JsonValue 擦除型 cast
3. 新增 `tests/peer-range.spec.ts` semver regression（同 chaos/bulkhead）
4. `CHANGELOG.md`（[0.1.2] Latest DSH compatibility fix）
5. 发版门禁：PCA-01~10 重跑 → pack → boundary/secret → clean-room → PR → merge →
   publish exact tgz → registry clean-room → tag/GitHub Release（npm/GitHub 认证同前）
   e2e.spec.ts 保持原样（仓库布局内运行，不进 patch）
