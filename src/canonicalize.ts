/**
 * Request canonicalization & fingerprinting.
 *
 * Splitting the canonicalizer out of the plugin entry keeps the normalization
 * contract independently testable: two requests canonicalize to the same
 * fingerprint iff the plugin may legally treat them as the same idempotency
 * operation (same tool, argument objects equal up to property order).
 * @module @why-daydream/dsh-tool-idempotency/canonicalize
 */

import { createHash } from 'node:crypto'

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Deep key-sort of a parsed-JSON value so argument objects differing only in
 * property order canonicalize identically (same idiom as
 * `@deepseek-ai/dsh-repeat-tool-reminder`).
 *
 * The sorted container is deliberately prototype-less: a plain `{}` target
 * would turn an own `__proto__` data key (legal in JSON, produced by
 * `JSON.parse`) into a prototype write, silently dropping a real argument
 * field and merging distinct requests into one fingerprint. `Object.keys`
 * sorts over the source's own enumerable keys only, so inherited members are
 * never serialized.
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/**
 * Fingerprint canonicalization version byte. Bumped whenever the canonical
 * serialization or hash changes, so in-process cache keys from an older plugin
 * version can never be mistaken for the new format (cross-restart persistence
 * is out of scope, but the byte keeps the contract future-proof).
 */
const CANONICAL_VERSION = 'v1'

/**
 * Deterministic SHA-256 (hex) request fingerprint.
 *
 * 0.2.0: FNV-1a 32 位升级为 SHA-256——消除实测可复现的指纹碰撞（O1，审计 P1）：
 * 不同参数请求不再因哈希碰撞被错误合并重放。node:crypto 为 Node 内建，无新增依赖。
 */
function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Request fingerprint: hash of tool name + canonicalized arguments.
 * SHA-256 + 规范化版本字节；碰撞概率可忽略，不同请求不得错误合并（0.2.0 契约）。
 */
export function fingerprintOf(exec: ToolExecution): string {
  const canonical = JSON.stringify(sortJsonValue(exec.arguments))
  return `${CANONICAL_VERSION}:${hashString(`${exec.name}\u0000${canonical}`)}`
}
