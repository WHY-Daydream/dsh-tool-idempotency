# B 阶段验收记录 — 2026-09-07

对象：`@why-daydream/dsh-tool-idempotency` P0 加固（执行锁淘汰 / owner settle /
JSON 自有字段丢失 / 在途容量拒绝）。本记录与源码/测试/打包同源同日，可复现。

## 环境

- Node v22.22.0 / npm 10.9.4 / linux x64
- TypeScript（`tsc -b`）、vitest 4.1.10、oxlint 未单独运行（lint 非本批门禁）
- 仓库 HEAD `b6db190` + 本会话未提交改动（src/tests/config/docs/compat）

## 命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck:tests`（`tsc -b tsconfig.json`） | 0 | src + 单元测试（e2e 除外）类型通过 |
| `npm run typecheck`（`tsc -b tsconfig.build.json`） | 0 | 发布面类型通过 |
| `npm run build` | 0 | lib/ 已从 src 重建（含 memory.ts 修复） |
| `npm run test:p0` | 0 | 18/18（canonicalize 7 + store-regression 11） |
| `npm run test:unit` | 0 | 68/68（index 22 + peer-range 28 + canonicalize 7 + store-regression 11） |
| `npm run test:e2e` | 0 | 2/2（Scenario A agent retry 去重 / Scenario B Saga+chaos 补偿） |
| `npm pack --json` | 0 | 产出 `why-daydream-dsh-tool-idempotency-0.1.2.tgz`（14047 B / unpacked 41491 B / 13 文件） |
| 隔离目录严格安装（同一份 tgz） | 0 | 21 packages，未 omit peer、未 --legacy-peer-deps |
| 运行时冒烟（同一份 tgz） | 0 | 公开入口 `.` 与 `/invariant` 加载；registry 闭包最小 pipeline 去重 calls=1 |

typecheck/build/test 的完整日志在本会话工具输出中；关键输出已在表内摘要。

## 打包产物

- tgz：`why-daydream-dsh-tool-idempotency-0.1.2.tgz`
- SHA-256：`c0e2781eb2e1bb7acab307d6bd3b79ee465a330830062172ecf2adba519c2f65`
- files（13）：LICENSE、README.md、README.en.md、cordis.patch.yml、package.json、
  `lib/index.{js,d.ts}`、`lib/canonicalize.{js,d.ts}`、`lib/invariant.{js,d.ts}`、
  `lib/stores/memory.{js,d.ts}`
- 白名单核验：包含 `lib/canonicalize.js`（修复项）；**不包含** src/ tests/ compat/ docs/
  （无测试夹具/审计文件泄漏）
- 打包发生在 `npm run build` 之后（lib 含 memory.ts no-op-catch 修复），
  产物与已验证源码一致

## tgz 严格安装（隔离目录 /tmp/dsh-idem-fixture2）

安装的精确版本（registry.npmjs.org）：

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `@why-daydream/dsh-tool-idempotency` | 0.1.2（本地 tgz） | 被测发布产物 |
| `@deepseek-ai/cordis` | 4.0.2 | peer 宿主（>=4.0.1 内） |
| `@deepseek-ai/dsh-tools` | 0.1.2-rc.1 | peer 宿主（union 内） |
| `@deepseek-ai/dsh-invariants` | 0.1.2-rc.1 | peer 宿主（union 内） |
| `@deepseek-ai/dsh-system-prompt` | 0.1.2-rc.1 | ToolRuntime 的 inject 依赖，冒烟需要 |

`npm ls --all --json` 全文另存 `/tmp/fixture2-npm-ls.json`（本文件只做摘要，避免仓库膨胀）。

## 测试实际加载的 DSH 集合（重要区分）

- **单元/E2E 测试**加载的是本地 `link:` dev 宿主 = `deepseek-harness` HEAD `47f9438`
  工作副本：`@deepseek-ai/dsh-tools` 0.1.0-rc.5、`dsh-invariants` 0.1.0-rc.5、
  vendor `cordis` 4.0.1、`dsh-llm` 0.1.0-rc.5 线。
  → **link 通过只证明该本地宿主通过，不能直接证明 npm 最新版兼容。**
- **tgz 冒烟**加载的是 npm registry 闭包（cordis 4.0.2 + dsh-tools/invariants/
  system-prompt 0.1.2-rc.1），但只做了「公开入口 + 最小 pipeline 去重」，**不等于
  完整兼容矩阵**（§2.2 各轨道、无插件对照、chaos/timeout/transaction 组合、registry
  闭包上的完整 Agent E2E 属 C 阶段）。

## 验收过程中修复的问题（均复验通过）

1. `vitest.config.ts`：vitest 4 移除了 `test.server.fs`，`fs.allow` 移到 Vite 顶层
   `server.fs`（原配置类型错误，且 runtime 不再生效）。
2. `tsconfig.json`：排除 `tests/e2e.spec.ts`（越界 `.ts` 导入 TS5097/TS6307，本地布局
   绑定，运行时验证面；注释说明理由）。
3. `src/stores/memory.ts`：`reserve()` 为 join deferred 预挂 no-op catch——claim 调用
   失败且无 join 者时，`fail()` 的 rejection 不再成为 ambient unhandled rejection
   （vitest 报 1 unhandled error 的根因）。
4. `tests/store-regression.spec.ts`：修正「failed placeholder frees slot」用例断言顺序
   （原断言与 `maxInFlight=1` 语义冲突：先 claim 了 other 再 claim K 必然被拒）。

## 边界验证结果（评审第 2 点）

- 在途打满时：同 key 重试 join（attempts 保持 1）、新 key 返回
  `IDEMPOTENCY_CAPACITY_REJECTED`、工具零执行 —— store 级 + 管线级用例通过。
- 占位先于下游执行（reserve 在 wrapper/`next()` 之前）；同步下游抛错 → `fail(owner)`
  释放锁 → 移除故障源后重试恰好执行一次（无僵尸锁）——用例通过。

## 证据归档（本目录内，避免 /tmp 丢失）

| 证据 | 位置 |
| --- | --- |
| 完整依赖树（registry 闭包 fixture2） | `compat/acceptance/fixture2-npm-ls.json`（10 KB，npm ls --all --json） |
| pack 产物清单（--json） | `compat/acceptance/pack-current-latest.json` |
| tgz 本体（同一份验收产物） | `compat/acceptance/why-daydream-dsh-tool-idempotency-0.1.2.tgz` |
| tgz SHA-256 | `compat/acceptance/tgz.sha256`（`c0e2781eb2e1bb7acab307d6bd3b79ee465a330830062172ecf2adba519c2f65`，与 B 阶段记录一致） |
| 运行日志（重跑归档，退出码全部 0） | `compat/acceptance/logs/{typecheck-tests,typecheck,build,test-p0,test-unit,test-e2e}.log` + `pack.log` |

```bash
# 复验摘要（归档时实测）
tc_tests=0 tc=0 build=0 p0=0 unit=0 e2e=0 pack=0
# test:p0 = 18/18；test:unit = 68/68；test:e2e = 2/2
```


- **unknown 场景**（副作用已提交但响应丢失/报错）：`isError`/抛错仍释放锁并允许重试，
  可能重复副作用；本批验收只覆盖修复自身语义，不宣称重试普遍安全。
- 完整兼容矩阵、registry 闭包上的完整 Agent E2E、timeout/取消/结构化结果/Saga
  组合测试 → C 阶段。
- 发布（npm publish）未执行：无发布凭证；版本号与门禁按方案阶段 D 决策。
