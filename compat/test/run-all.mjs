#!/usr/bin/env node
/**
 * compat/test/run-all.mjs — 业务正确性套件可重放入口（test-matrix.md §4 引用）。
 *
 * 按序执行：typecheck:tests → test:p0 → test:unit → test:correctness → test:e2e。
 * 任一步非零即整体失败（exit != 0），并打印每步摘要；不修改任何源文件。
 *
 * 用法（仓库根目录）：
 *   node compat/test/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const steps = [
  ['typecheck:tests', 'npm', ['run', 'typecheck:tests']],
  ['test:p0', 'npm', ['run', 'test:p0']],
  ['test:unit', 'npm', ['run', 'test:unit']],
  ['test:correctness', 'npm', ['run', 'test:correctness']],
  ['test:e2e', 'npm', ['run', 'test:e2e']],
]

let failed = false
console.log(`[run-all] 起点 ${new Date().toISOString()} node=${process.version} cwd=${ROOT}`)
for (const [name, cmd, args] of steps) {
  const out = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000 })
  const ok = out.status === 0
  const summary = ok
    ? (out.stdout || '').trim().split('\n').filter((l) => /Test Files|Tests +[0-9]/.test(l)).slice(-2).join(' | ')
    : `exit=${out.status ?? 'timeout'} ${(out.stderr || out.stdout || '').trim().split('\n').slice(-2).join(' | ')}`
  console.log(`[run-all] ${ok ? 'PASS' : 'FAIL'} ${name}${summary ? ' — ' + summary : ''}`)
  if (!ok) failed = true
}
console.log(failed ? '[run-all] FAIL — 存在失败步骤，见上方摘要' : '[run-all] ALL PASS')
process.exit(failed ? 1 : 0)
