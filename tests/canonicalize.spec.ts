/**
 * Regression suite for request canonicalization (P0: JSON own-field loss).
 *
 * Pre-fix behavior (HEAD b6db190): `sortJsonValue` assembled the sorted object
 * on a plain `{}`, so an own `__proto__` data key (legal JSON, produced by
 * `JSON.parse`) became a prototype write and was silently dropped — two
 * different requests canonicalized to the same fingerprint and the second was
 * wrongly replayed. These cases fail on the old implementation and must pass
 * on the fixed one.
 */

import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { fingerprintOf, sortJsonValue } from '../src/canonicalize.js'

function fp(name: string, args: unknown): string {
  return fingerprintOf({ name, arguments: args } as unknown as ToolExecution)
}

/** Build an object with `__proto__` as a real own data property, as JSON.parse does. */
function parsed(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

describe('canonicalize — own-field preservation (P0)', () => {
  it('keeps an own __proto__ field instead of writing the object prototype', () => {
    const sorted = sortJsonValue(parsed('{"__proto__":{"x":1},"a":1}')) as Record<string, unknown>
    expect(Object.getPrototypeOf(sorted)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(sorted, '__proto__')).toBe(true)
    expect(Object.keys(sorted)).toEqual(['__proto__', 'a'])
    expect((sorted['__proto__'] as { x: number }).x).toBe(1)
    expect(JSON.stringify(sorted)).toBe('{"__proto__":{"x":1},"a":1}')
  })

  it('does not pollute Object.prototype while canonicalizing', () => {
    sortJsonValue(parsed('{"__proto__":{"polluted":true}}'))
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('distinguishes a request with an own __proto__ field from one without — no merge', () => {
    expect(fp('t', parsed('{"__proto__":{"x":1},"a":1}'))).not.toBe(fp('t', parsed('{"a":1}')))
  })

  it('distinguishes own constructor / prototype JSON fields from their absence', () => {
    expect(fp('t', parsed('{"constructor":{"x":1}}'))).not.toBe(fp('t', parsed('{}')))
    expect(fp('t', parsed('{"prototype":{"x":1}}'))).not.toBe(fp('t', parsed('{}')))
  })

  it('treats requests equal up to property order as the same request — special keys included', () => {
    expect(fp('t', parsed('{"__proto__":{"x":1},"a":1}'))).toBe(fp('t', parsed('{"a":1,"__proto__":{"x":1}}')))
    expect(fp('t', { a: 1, b: 2 })).toBe(fp('t', { b: 2, a: 1 }))
  })

  it('keeps nested objects order-insensitive and arrays order-sensitive', () => {
    expect(fp('t', { n: { a: 1, b: 2 }, c: 3 })).toBe(fp('t', { c: 3, n: { b: 2, a: 1 } }))
    expect(fp('t', { xs: [1, 2] })).not.toBe(fp('t', { xs: [2, 1] }))
  })

  it('keeps the tool name and Unicode payload in the fingerprint', () => {
    expect(fp('a', { x: 1 })).not.toBe(fp('b', { x: 1 }))
    const zh = { 订单: '甲', 备注: '中文' }
    expect(fp('t', zh)).toBe(fp('t', { 备注: '中文', 订单: '甲' }))
    expect(fp('t', zh)).not.toBe(fp('t', { 订单: '甲', 备注: '英文' }))
  })

  it('0.2.0 回归（O1）：FNV-1a 实测碰撞对在 SHA-256 下不再碰撞', () => {
    // 0.1.3 FNV-1a 实测碰撞对（审计 P1/O1）：规范字符串不同但旧指纹同为 12077584。
    // 0.2.0 升级 SHA-256 + 规范化版本字节后必须区分。
    const COLLISION_A = { x: 's406053133' }
    const COLLISION_B = { d: { inner: 967754 }, z: 's428930447' }
    const fa = fp('create_order', COLLISION_A)
    const fb = fp('create_order', COLLISION_B)
    expect(JSON.stringify(COLLISION_A)).not.toBe(JSON.stringify(COLLISION_B))
    expect(fa).not.toBe(fb)
    expect(fa).not.toBe('12077584')
    expect(fa).toMatch(/^v1:[0-9a-f]{64}$/) // 规范化版本字节 + SHA-256 hex
    expect(fb).toMatch(/^v1:[0-9a-f]{64}$/)
  })
})
