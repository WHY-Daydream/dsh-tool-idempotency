# 发布候选记录 — 0.2.0（2026-09-08）

> **发布状态：✅ 已于 2026-09-08 发布到 npm registry**（`@why-daydream/dsh-tool-idempotency@0.2.0`，
> dist-tags latest=0.2.0）。发布的是已验收归档 `compat/acceptance/why-daydream-dsh-tool-idempotency-0.2.0.tgz`
> （sha256 `d923c8eba07dbbfef6733924c190d22d806573d9cdb2029bb688f03b7a12ea29`，tag `v0.2.0` → GH Actions
> npm-publish，run 34176379444 attempt 2，「发布这份已验收归档」步骤 success）。
>
> 发布后独立复验（本会话，非 workflow 自检）：registry 下载包 sha256 == 验收归档（`tgz-0.2.0.sha256`）；
> registry `dist.integrity` == 归档 tgz 的 sha512-integrity（`sha512-AnjQwnoedSsXcKgALf6EFDgOwn/BDSMu6uYLqcTdU71uZXJAsSxX45zGyODhWVARbhVVGU1WS1lnimQDiKsKzw==`）；
> 干净目录（非 fixture）安装 registry 0.2.0 后 baseline OK、regression 14/14、agent-e2e 去重冒烟
> （executions=1，副作用恰 1 次）均 EXIT 0。

## 版本与发布状态

- 版本：**0.2.0**（package.json 已升；归档内部 name/version = `@why-daydream/dsh-tool-idempotency` / `0.2.0`）。
- npm 现状（发布前）：`latest=0.1.3`，版本仅 0.1.0/0.1.1/0.1.3；0.2.0 不存在。
- npm 现状（发布后）：`latest=0.2.0`，版本含 0.2.0。
- 发布通道：**GH Actions npm-publish**（本机无发布凭证 ENEEDAUTH；workflow 以 `secrets.NPM_TOKEN` →
  `NODE_AUTH_TOKEN` 发布，tag `v*` 推送触发；0.1.3 同通道，run 34100982148/34100980983 success）。

## 本版内容（相对 npm 0.1.3）

1. **unknown 状态机**：副作用已提交但响应丢失/超时（abort）后不再盲重执行——状态置
   `unknown`，自动重试被 `IDEMPOTENCY_STATE_UNKNOWN` 阻止，提供 query/confirm/release/
   invalidate 对账接口（P1/K1 闭环）。
2. **Saga 补偿一致性**：补偿成功不重放旧成功结果；invalidate/代次机制 + 补偿独立幂等身份
   （P1-2/K2 闭环）。
3. **fencing token（executionId）**：每轮执行分配 `crypto.randomUUID()`，永不回退、生命周期唯一；
   对账校验 `fingerprint + expectedExecutionId`（同源读取），stale release/confirm/invalidate
   拒绝（`IDEMPOTENCY_GENERATION_MISMATCH`）——ABA / token reuse 修复（P1-3a/3b CLOSED）。
4. **transaction × idempotency 组合兼容**：peer 声明 UNION 覆盖 0.1.x 预发布宿主线；两条宿主线
   （current-latest / prev-release）真实联网 clean install 无 ERESOLVE、无 peer 绕过。

## 验收状态（最终 0.2.0 同一份 tgz 实测，见 test-matrix.md §14）

- GATE-TI-1..5 **CLEARED**（2026-09-08）：两线严格 `npm install`（27 包 / 19 包，无 ERESOLVE）、
  两线 combo-acceptance 4 场景全 PASS、全套件 `run-all.mjs` ALL PASS exit 0
  （typecheck + p0 26/26 + unit 77/77 + correctness 89/89 + e2e 2/2 + combo 阶段）。
- 产物：`why-daydream-dsh-tool-idempotency-0.2.0.tgz`
  SHA-256：`d923c8eba07dbbfef6733924c190d22d806573d9cdb2029bb688f03b7a12ea29`
  （`compat/acceptance/tgz-0.2.0.sha256`，2026-09-08 已改为裸文件名与 CI 门禁 working-directory 一致）。
- 归档内部 name/version：`@why-daydream/dsh-tool-idempotency` / `0.2.0`（tar 读取实测）。

## 发布执行记录（2026-09-08）

1. 本机前置核验：`sha256sum -c tgz-0.2.0.sha256`（裸名格式，于 compat/acceptance 内）PASS；归档
   内部 name/version 比对 PASS。
2. commit `0e79896`（fix: sha 文件格式）→ push origin/0.2.0；tag `v0.2.0`（= `16f0325`）→ push 触发
   npm-publish。
3. GH Actions run 34176379444：
   - attempt 1：步骤 9（npm publish）failure——`npm error E404`（npm 接收发布请求时拒绝，tgz 已正常
     读取；非 tag/打包/需预建版本问题）。
   - 负责人侧检查 token 权限（Read and write / Bypass 2FA）并更新 `NPM_TOKEN` secret 后
     **Re-run failed jobs**。
   - attempt 2：步骤 1-9 全 success（含 sha256 门禁、registry 预检、发布动作）；步骤 10
     「发布后复验」failure——`npm view @0.2.0 dist.integrity` 立即查询撞 **npm 读传播延迟**
     （E404 No match for version 0.2.0）。**发布本身成功**（registry 已落 0.2.0）；复验步骤为
     竞态假阴性，已由下方独立复验补齐。
4. 独立复验（本会话，全部实测）：
   - `npm view @why-daydream/dsh-tool-idempotency@0.2.0 version dist.tarball dist.integrity` → 0.2.0
     存在，tarball URL 正常，integrity 与归档 sha512 **一致**。
   - `npm view ... versions` → [0.1.0, 0.1.1, 0.1.3, 0.2.0]；`dist-tags.latest` = 0.2.0。
   - 干净目录 `/tmp/dsh-postpub-0.2.0`：`npm install @why-daydream/dsh-tool-idempotency@0.2.0` +
     宿主闭包（cordis 4.0.2 / dsh-* 0.1.2-rc.1）成功；`npm pack "@...@0.2.0"` 下载包 sha256 ==
     `d923c8eb…`（MATCH OK）；baseline OK、regression **14/14**、agent-e2e 去重冒烟
     `executions=1`（副作用恰 1 次）EXIT 0。
   - 版本核对：脚本内 `[VERSION] plugin loaded = 0.2.0`。

## 发布后复验步骤（后续可重放）

```bash
# 1. registry 完整性
npm view "@why-daydream/dsh-tool-idempotency@0.2.0" dist.integrity   # == 归档 tgz sha512
# 2. 干净目录下载包冒烟（sha256 比对 + 去重冒烟）
cd /tmp && rm -rf postpub && mkdir postpub && cd postpub && npm init -y
npm install @why-daydream/dsh-tool-idempotency@0.2.0
npm pack "@why-daydream/dsh-tool-idempotency@0.2.0"
sha256sum why-daydream-dsh-tool-idempotency-0.2.0.tgz   # == compat/acceptance/tgz-0.2.0.sha256
# 去重冒烟：对同一工具调用两次 → 副作用 1 次（脚本见 compat/fixtures/current-latest-0.2.0/agent-e2e.mjs）
# regression 14/14（compat/fixtures/current-latest-0.2.0/regression.mjs）
```

## 审阅入口

- 补丁/资产：`compat/acceptance/dsh-0.2.0-review-1131f14..0.2.0.patch`、
  `dsh-0.2.0-review-v0.1.3..0.2.0.patch`、`dsh-0.2.0-review-files.zip`、
  `dsh-0.2.0-review-bundle-2026-09-07.bundle`（`deliverables-0.2.0.sha256` 锁定）。
- 报告：`acceptance-b-2026-09-07.md`、`acceptance-c-2026-09-07.md`、`release-scope-2026-09-07.md`、
  `compat/test/test-matrix.md` §14（GATE-TI）+ §14.4（真实联网执行证据，2026-09-08 归档日志）。
- fixtures（可重放）：`compat/fixtures/transaction-combo-0.2.0/`、
  `transaction-combo-prev-release-0.2.0/`、`current-latest-0.2.0/`、`prev-release-0.1.1-rc.2-0.2.0/`。
