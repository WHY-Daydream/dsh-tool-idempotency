/**
 * Request canonicalization & fingerprinting.
 *
 * Splitting the canonicalizer out of the plugin entry keeps the normalization
 * contract independently testable: two requests canonicalize to the same
 * fingerprint iff the plugin may legally treat them as the same idempotency
 * operation (same tool, argument objects equal up to property order).
 * @module @why-daydream/dsh-tool-idempotency/canonicalize
 */
import { createHash } from 'node:crypto';
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
export function sortJsonValue(value) {
    if (Array.isArray(value))
        return value.map(sortJsonValue);
    if (value !== null && typeof value === 'object') {
        const record = value;
        const sorted = Object.create(null);
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortJsonValue(record[key]);
        }
        return sorted;
    }
    return value;
}
/**
 * Fingerprint canonicalization version byte. Bumped whenever the canonical
 * serialization or hash changes, so in-process cache keys from an older plugin
 * version can never be mistaken for the new format (cross-restart persistence
 * is out of scope, but the byte keeps the contract future-proof).
 */
const CANONICAL_VERSION = 'v1';
/**
 * Deterministic SHA-256 (hex) request fingerprint.
 *
 * 0.2.0：**修复 0.1.3 实测的 FNV-1a 碰撞对**（审计 O1/P1），指纹升级为 SHA-256
 * （node:crypto 内建，无新增依赖）。SHA-256 使碰撞概率大幅降低，但**不作绝对保证**
 * ——任何哈希都有理论碰撞可能；「不同请求不得错误合并」以已实测碰撞对回归为准。
 */
function hashString(input) {
    return createHash('sha256').update(input).digest('hex');
}
/**
 * Request fingerprint: hash of tool name + canonicalized arguments.
 * SHA-256 + 规范化版本字节；**修复已知 FNV 碰撞对**，碰撞概率大幅降低
 * （非绝对免碰撞；0.2.0 契约以实测碰撞对回归为准）。
 */
export function fingerprintOf(exec) {
    const canonical = JSON.stringify(sortJsonValue(exec.arguments));
    return `${CANONICAL_VERSION}:${hashString(`${exec.name}\u0000${canonical}`)}`;
}
