/**
 * Request canonicalization & fingerprinting.
 *
 * Splitting the canonicalizer out of the plugin entry keeps the normalization
 * contract independently testable: two requests canonicalize to the same
 * fingerprint iff the plugin may legally treat them as the same idempotency
 * operation (same tool, argument objects equal up to property order).
 * @module @why-daydream/dsh-tool-idempotency/canonicalize
 */
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
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
export declare function sortJsonValue(value: unknown): unknown;
/**
 * Request fingerprint: hash of tool name + canonicalized arguments.
 * SHA-256 + 规范化版本字节；**修复已知 FNV 碰撞对**，碰撞概率大幅降低
 * （非绝对免碰撞；0.2.0 契约以实测碰撞对回归为准）。
 */
export declare function fingerprintOf(exec: ToolExecution): string;
