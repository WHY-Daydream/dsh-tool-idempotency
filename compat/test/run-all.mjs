#!/usr/bin/env node
/**
 * compat/test/run-all.mjs — 业务正确性套件可重放入口（test-matrix.md §4 引用）。
 *
 * 按序执行：typecheck:tests → test:p0 → test:unit → test:correctness → test:e2e
 * →（GATE-TI-5）combo:transaction×idempotency（fixture 已安装时）。
 * 任一步非零即整体失败（exit != 0）；组合 fixture 未安装时报告 BLOCKED 并整体失败
 * （组合验收必须进入 run-all，不留人工验证记录）。不修改任何源文件。
 *
 * 用法（仓库根目录）：
 *   node compat/test/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// GATE-TI-5：transaction × idempotency 组合验收 fixture（脚本内置版本校验与 4 场景）
const COMBO_FIXTURE = join(ROOT, 'compat', 'fixtures', 'transaction-combo-0.2.0')
const comboInstalled = existsSync(
  join(COMBO_FIXTURE, 'node_modules', '@why-daydream', 'dsh-tool-transaction'),
)

const steps = [
  ['typecheck:tests', 'npm', ['run', 'typecheck:tests'], ROOT],
  ['test:p0', 'npm', ['run', 'test:p0'], ROOT],
  ['test:unit', 'npm', ['run', 'test:unit'], ROOT],
  ['test:correctness', 'npm', ['run', 'test:correctness'], ROOT],
  ['test:e2e', 'npm', ['run', 'test:e2e'], ROOT],
  ...(comboInstalled
    ? [['combo:transaction×idempotency', 'node', ['combo-acceptance.mjs'], COMBO_FIXTURE]]
    : []),
]

let failed = false
if (!comboInstalled) {
  console.log(
    '[run-all] BLOCKED combo:transaction×idempotency — fixture 未安装'
    + '（cd compat/fixtures/transaction-combo-0.2.0 && npm ci 后重跑；禁用 peer 绕过）',
  )
  failed = true
}
console.log(`[run-all] 起点 ${new Date().toISOString()} node=${process.version} cwd=${ROOT}`)
for (const [name, cmd, args, cwd] of steps) {
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300_000 })
  const ok = out.status === 0
  const summary = ok
    ? (out.stdout || '').trim().split('\n').filter((l) => /Test Files|Tests +[0-9]|\[COMBO\]/.test(l)).slice(-2).join(' | ')
    : `exit=${out.status ?? 'timeout'} ${(out.stderr || out.stdout || '').trim().split('\n').slice(-2).join(' | ')}`
  console.log(`[run-all] ${ok ? 'PASS' : 'FAIL'} ${name}${summary ? ' — ' + summary : ''}`)
  if (!ok) failed = true
}
console.log(failed ? '[run-all] FAIL — 存在失败或 BLOCKED 步骤，见上方摘要' : '[run-all] ALL PASS')
process.exit(failed ? 1 : 0)
