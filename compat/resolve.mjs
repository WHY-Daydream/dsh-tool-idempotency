/**
 * compat:resolve — 重新解析 npm dist-tags 并生成「本次目标快照」，与原基线比较。
 *
 * 设计约束（审计文档 §2.1 / §6.1，2026-09-07 复核修订）：
 * - 只做只读 registry 查询（等价于 `npm view`），不安装、不修改源码；
 * - **绝不静默覆盖原基线**：每次解析默认写入
 *   `compat/snapshots/targets-<frozenAt>.json`，并把与原 `targets.lock.json`
 *   的差异打印到 stdout，保留追溯依据；
 * - 只有显式 `--promote` 才用本次快照替换 `targets.lock.json`（替换前先把旧基线
 *   备份到 `compat/snapshots/`）；
 * - 宿主闭包安装与 `npm ls --all --json` 由 fixture 阶段执行（见 compat/README.md）。
 *
 * 用法：
 *   node compat/resolve.mjs            # 解析并打印快照内容
 *   node compat/resolve.mjs --snapshot # 另存 compat/snapshots/targets-<时间>.json 并打印差异
 *   node compat/resolve.mjs --diff     # 只打印「本次解析 vs 当前锁文件」差异
 *   node compat/resolve.mjs --promote  # 差异确认后：备份旧锁 → 用本次快照替换 targets.lock.json
 * 前提：npm 可用且 registry 可达（npm view 可跑）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT_DIR = join(ROOT, 'compat')
const SNAPSHOT_DIR = join(COMPAT_DIR, 'snapshots')
const LOCK_PATH = join(COMPAT_DIR, 'targets.lock.json')

/** 包装 `npm view <spec> <field...> --json`；失败抛错，绝不静默回退。 */
function npmView(spec, ...fields) {
  const args = ['view', spec, ...fields, '--json']
  const out = spawnSync('npm', args, { encoding: 'utf8', timeout: 60_000 })
  if (out.status !== 0) {
    throw new Error(`npm view ${spec} 失败 (exit ${out.status}): ${(out.stderr || out.stdout || '').trim().slice(0, 500)}`)
  }
  return JSON.parse(out.stdout)
}

function distTagsOf(pkg) {
  const tags = npmView(pkg, 'dist-tags')
  const result = {}
  for (const [tag, version] of Object.entries(tags)) {
    const { version: v, dist } = npmView(`${pkg}@${version}`, 'version', 'dist')
    result[tag] = { version: v, integrity: dist.integrity ?? null }
  }
  return result
}

/** 本次解析出的 registry 快照（只含可自动查询的字段）。 */
function resolveSnapshot() {
  const frozenAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    kind: 'registry-snapshot',
    frozenAt,
    registry: 'https://registry.npmjs.org/',
    plugin: { name: '@why-daydream/dsh-tool-idempotency', npm: { distTags: distTagsOf('@why-daydream/dsh-tool-idempotency') } },
    hosts: {
      cli: { name: '@deepseek-ai/dsh', distTags: distTagsOf('@deepseek-ai/dsh') },
      tools: { name: '@deepseek-ai/dsh-tools', distTags: distTagsOf('@deepseek-ai/dsh-tools') },
      invariants: { name: '@deepseek-ai/dsh-invariants', distTags: distTagsOf('@deepseek-ai/dsh-invariants') },
      cordis: { name: '@deepseek-ai/cordis', distTags: distTagsOf('@deepseek-ai/cordis') },
    },
    companionPlugins: {
      '@why-daydream/dsh-chaos': distTagsOf('@why-daydream/dsh-chaos'),
      '@why-daydream/dsh-tool-transaction': distTagsOf('@why-daydream/dsh-tool-transaction'),
    },
  }
}

/** 扁平化 dist-tags 为 `包/distTag -> {version, integrity}`，便于做逐项差异。 */
function flatten(snapshot) {
  const flat = {}
  const push = (label, distTags) => {
    for (const [tag, { version, integrity }] of Object.entries(distTags ?? {})) {
      flat[`${label}@${tag}`] = { version, integrity }
    }
  }
  push(snapshot.plugin?.name ?? 'plugin', snapshot.plugin?.npm?.distTags)
  for (const [key, host] of Object.entries(snapshot.hosts ?? {})) push(host.name ?? key, host.distTags)
  for (const [name, distTags] of Object.entries(snapshot.companionPlugins ?? {})) push(name, distTags)
  return flat
}

/** 比较两个快照，返回人类可读差异行。 */
function diffSnapshots(before, after) {
  const a = flatten(before)
  const b = flatten(after)
  const lines = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]).keys()) {
    const av = a[key]
    const bv = b[key]
    if (av === undefined) lines.push(`+ ${key} → ${bv.version} (${bv.integrity ?? 'no-integrity'})`)
    else if (bv === undefined) lines.push(`- ${key} → 已从 registry 消失 (last ${av.version})`)
    else if (av.version !== bv.version || av.integrity !== bv.integrity) {
      lines.push(`~ ${key}: ${av.version} → ${bv.version}${av.integrity !== bv.integrity ? ' (integrity changed)' : ''}`)
    }
  }
  return lines
}

const flags = new Set(process.argv.slice(2))
const snapshot = resolveSnapshot()

// --diff：只打印与当前锁文件的差异（不落盘）
if (flags.has('--diff')) {
  const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : undefined
  const lines = lock ? diffSnapshots(lock, snapshot) : ['（无现有锁文件可比）']
  console.log(`差异（registry 解析于 ${snapshot.frozenAt}）：`)
  console.log(lines.length === 0 ? '（与 targets.lock.json 一致，无变化）' : lines.join('\n'))
  process.exit(0)
}

// 默认落盘为时间戳快照（永不覆盖），便于追溯。
mkdirSync(SNAPSHOT_DIR, { recursive: true })
const snapshotPath = join(SNAPSHOT_DIR, `targets-${snapshot.frozenAt.replace(/[:.]/g, '-')}.json`)
const text = `${JSON.stringify(snapshot, null, 2)}\n`

if (flags.has('--promote')) {
  // 差异确认后：备份旧基线 → 用本次快照替换 targets.lock.json
  if (existsSync(LOCK_PATH)) {
    const old = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    const backupPath = join(SNAPSHOT_DIR, `targets-backup-${(old.frozenAt ?? 'unknown').replace(/[:.]/g, '-')}.json`)
    copyFileSync(LOCK_PATH, backupPath)
    console.log(`已备份原基线 → ${backupPath}`)
  }
  writeFileSync(LOCK_PATH, text, 'utf8')
  console.log(`已用本次快照替换 ${LOCK_PATH}`)
  const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : undefined
  const lines = lock ? diffSnapshots(lock, snapshot) : []
  console.log('与替换前基线差异：')
  console.log(lines.length === 0 ? '（无变化）' : lines.join('\n'))
} else {
  writeFileSync(snapshotPath, text, 'utf8')
  console.log(`本次 registry 快照 → ${snapshotPath}`)
  if (existsSync(LOCK_PATH)) {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    const lines = diffSnapshots(lock, snapshot)
    console.log('与 targets.lock.json 差异：')
    console.log(lines.length === 0 ? '（一致，无变化）' : lines.join('\n'))
  } else {
    console.log('（无现有 targets.lock.json；如需替换为本次快照请加 --promote）')
  }
  console.log('注意：快照只含 registry 自动查询字段；git HEAD/peerUnion/sourceTracks 等静态事实不在此脚本范围。')
}
