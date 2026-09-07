# 发布候选记录 — 0.1.3（2026-09-07）

> **发布状态：✅ 已于 2026-09-07 发布到 npm registry**（`@why-daydream/dsh-tool-idempotency@0.1.3`，
> dist-tags latest=0.1.3）。发布的是已验收归档 `compat/acceptance/why-daydream-dsh-tool-idempotency-0.1.3.tgz`。
> 发布后复验：registry 下载 sha256 = `06b6ee245fe5b8ec838f80f90883f7ce2b0c5acf9219c51f273b32a3ecf41fb0`
> 与验收归档一致；干净目录（非 fixture）安装 registry 0.1.3 后 agent-e2e 去重冒烟
> （executions=1）与 regression 14/14 均 EXIT 0。unknown 与 Saga 限制随本版保留并声明。

范围决策（负责人已确认分支 A）：**先交付两个 P0 修复 + 兼容更新为 0.1.3 候选，收窄
安全承诺；unknown 状态机与补偿失效机制单独走 0.2.0。** 本记录满足发布前条件：实际
diff 可审阅（补丁路径见文末）、行为变化明确、两个 FAIL 缺口显著声明并接受、最终产物
同一份验证、发布后下载复验步骤齐备。

## 版本与发布状态

- 版本：**0.1.3**（package.json 已升；0.1.2 从未发布，其内容并入本版；CHANGELOG 已
  标注 [0.1.2] 未发布）。
- npm 现状：`latest=0.1.1`（含两个已修复的 P0 缺陷）。
- 发布动作：**未执行。`npm whoami` → ENEEDAUTH**（本机无发布凭证）。发布需负责人
  登录（`npm adduser`）或提供 token 后执行，本记录含发布与复验步骤。

## 本版内容（相对 npm 0.1.1）

1. 最新 DSH 兼容：peer 声明 per-line union（0.1.2 线源码，未发布，并入本版）。
2. **P0-1 执行锁**：executing 锁不再被缓存容量/TTL 淘汰；settle/fail 带 owner 校验；
   在途容量打满显式拒绝（`IDEMPOTENCY_CAPACITY_REJECTED`），同 key 重试仍 join。
3. **P0-2 参数判等**：JSON 规范化保留 `__proto__`/`constructor`/`prototype` 自有字段。
4. **行为变化（不是「无运行时行为变化」）**：新增 `maxInFlight`（默认 256）→ 高并发
   时新的不同 key 调用可能被容量拒绝；`maxEntries` 语义收窄为成功缓存上限。升级注意
   见 `docs/UPGRADE.md`。

## 验收状态（最终 0.1.3 同一份 tgz 实测）

产物：`why-daydream-dsh-tool-idempotency-0.1.3.tgz`
SHA-256：`06b6ee245fe5b8ec838f80f90883f7ce2b0c5acf9219c51f273b32a3ecf41fb0`
（`compat/acceptance/tgz-0.1.3.sha256`；13 文件，files 白名单合规，无 src/tests 泄漏；
`exports` 已移除 `./src/*`）

> 修订记录：本记录在 commit 631cc44 代码评审后更新——四项意见（P1-1 abort-aware
> join 与取消屏障、P1-2 同 tgz 发布门禁、P2-3 三态输出与 Saga 精确断言、P2-4 移除
> 无效 exports）全部处理并复验；产物 SHA 随 exports/lib 变更重生成。详见
> `acceptance-c-2026-09-07.md`「评审修订轮」与 `CHANGELOG.md`。
>
> 修订记录 2（commit bbb0c2c 后，评审 round 2 认可）：npm-publish.yml 改为发布
> **已验收归档**（`sha256sum -c tgz-<版本>.sha256` 通过才发，不重打包）；版本号取自
> package.json 并核验归档存在，tag 触发时发布前校验 tag==版本，发布后 integrity
> 复验用同一版本号；c3 joined 屏障事件化（探针 + 微任务，替代 sleep）。发布包内容
> 未变，SHA 保持 `06b6ee24…`。
>
> 修订记录 3（round 3，非阻塞）：workflow 注释改为“版本解析自仓库 package.json”，
> 新增归档内部 name/version 显式比对步骤（失败即停）。发布包内容仍未变。

| 验收 | 结果 |
| --- | --- |
| typecheck:tests / typecheck / build（src=0.1.3） | EXIT 0 |
| test:p0 18/18；test:unit 68/68；test:e2e 2/2（本地 dev 宿主） | EXIT 0 |
| registry 0.1.2-rc.1 闭包：baseline + regression 14/14 + c3 + agent-e2e + structured | 全 EXIT 0 |
| registry 0.1.1-rc.2 闭包：baseline + regression 14/14 | 全 EXIT 0 |
| C3 正确性断言 | 4 PASS（replay/waiter 取消/owner 取消/提交前 abort） |
| C3 缺陷复现 | 2 FAIL（见下，本版接受） |

## 本版明确接受的两个已知限制（FAIL 复现，不宣称修复）

1. **unknown**：副作用已提交但响应丢失/超时（abort）后，重试会再次执行该副作用
   （registry 0.1.2-rc.1 实测 effects=2）。→ 写操作**不承诺 exactly-once**；安全重试
   需下游幂等 key / 唯一约束 / 对账。README/CHANGELOG/UPGRADE 已显著声明。
2. **Saga 补偿后一致性**：补偿成功后同业务 key 请求会被重放旧「已创建」成功结果
   （实测复现）。→ 业务需新 key / 清缓存 / 等 TTL；invalidate / 代次机制属 0.2.0。
3. 其余边界（已声明、未视为缺陷）：内存 store 跨重启/多实例无历史去重；结构化字段
   `meta/additionalContexts/concludesTurn` 未被本批 fixture 覆盖（不宣称支持或不支持）；
   业务 key 隔离断言 ≠ callId/session 身份隔离验证（未做）。

## 发布与复验步骤（负责人执行）

```bash
# 0. 前置：npm adduser（负责人本机登录）——当前环境 ENEEDAUTH
# 1. 仓库最终自检（本机已全部 EXIT 0，可重跑确认）
npm run typecheck:tests && npm run typecheck && npm run build
npm run test:p0 && npm run test:unit && npm run test:e2e

# 2. 打包（发布门禁：发布**已验收的那一份 tgz**，禁止测试后另行重建）
npm pack --json            # 产出 why-daydream-dsh-tool-idempotency-0.1.3.tgz
sha256sum -c compat/acceptance/tgz-0.1.3.sha256   # 必须与验收归档一致；产物内容变化时先重生成并复验

# 3. 发布（显式发布已验收的同一份 tgz，不是裸 npm publish 重打包工作目录）
npm publish ./compat/acceptance/why-daydream-dsh-tool-idempotency-0.1.3.tgz --access public

# 4. 发布后下载复验（必须含哈希比对与去重冒烟，不能只验证入口加载）
cd /tmp && rm -rf postpub && mkdir postpub && cd postpub && npm init -y
npm install @why-daydream/dsh-tool-idempotency@0.1.3
npm pack "@why-daydream/dsh-tool-idempotency@0.1.3"   # 从 registry 下载的包
sha256sum why-daydream-dsh-tool-idempotency-0.1.3.tgz # 必须等于 compat/acceptance/tgz-0.1.3.sha256
# 去重冒烟：装好 peer 闭包后对同一工具调用两次 → 副作用 1 次（脚本见 compat/fixtures/current-latest/agent-e2e.mjs）
npm view "@why-daydream/dsh-tool-idempotency@0.1.3" dist.integrity  # 与发布前 npm pack 的 integrity 一致
```

## 审阅入口

- 补丁：`compat/acceptance/b-stage-2026-09-07.patch`（1226 行）、
  `compat/acceptance/c-stage-2026-09-07.patch`（2032 行，含 fixtures/脚本）；
  本记录与 README/CHANGELOG 的 0.1.3 改动已生成最终补丁 `c-stage` 需重新生成一次
  （含版本升号与文档改动），随最终交付附上。
- 报告：`acceptance-b-2026-09-07.md`、`acceptance-c-2026-09-07.md`、`release-scope-2026-09-07.md`
- fixtures（可重放，npm ci 后 node 各 .mjs）：`compat/fixtures/current-latest/`、`prev-release-0.1.1-rc.2/`
