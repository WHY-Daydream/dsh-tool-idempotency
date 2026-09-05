import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import semver from 'semver'

const require = createRequire(import.meta.url)
const manifest = require('../package.json') as {
  peerDependencies: Record<string, string>
}

/**
 * The supported DSH runtime window (PCA-02 audit draft, frozen into v0.1.2):
 * every released / in-source DSH prerelease line gets an explicit per-tuple
 * union member — npm semver only lets a prerelease match a range whose set
 * contains a prerelease comparator sharing its major.minor.patch tuple, so a
 * bare `>=0.0.1-rc.1` floor (published v0.1.1) excludes every 0.1.x line
 * (npm ERESOLVE). Do NOT collapse members back into a single bounded range,
 * and do NOT add a new 0.1.x tuple member before its PCA-07/PCA-09 acceptance
 * has been re-run. 0.2.x is never auto-opened (`<0.2.0-0` bounds every member).
 */
const peers = manifest.peerDependencies

const UNION_RC1 = '>=0.0.1-rc.1 <0.1.0-0 || >=0.1.0-0 <0.2.0-0 || >=0.1.1-0 <0.2.0-0 || >=0.1.2-0 <0.2.0-0 || >=0.1.3-0 <0.2.0-0'

describe('peer range @deepseek-ai/dsh-* (latest-DSH compatibility, PCA-02 frozen)', () => {
  it('declares the audited per-line union (no bare floors, no future-tuple promises)', () => {
    expect(peers['@deepseek-ai/dsh-invariants']).toBe(UNION_RC1)
    expect(peers['@deepseek-ai/dsh-tools']).toBe(UNION_RC1)
    // cordis is a stable 4.0.x line: unchanged unbounded floor
    expect(peers['@deepseek-ai/cordis']).toBe('>=4.0.1')
  })

  // Every published version of each consumed runtime package must stay in-window.
  it.each([
    ['dsh-invariants', '0.0.1-rc.1', UNION_RC1], ['dsh-invariants', '0.0.1-rc.2', UNION_RC1],
    ['dsh-invariants', '0.0.1-rc.5', UNION_RC1], ['dsh-invariants', '0.1.0-rc.6', UNION_RC1],
    ['dsh-invariants', '0.1.0-rc.8', UNION_RC1], ['dsh-invariants', '0.1.1-rc.2', UNION_RC1],
    ['dsh-invariants', '0.1.2-alpha.5', UNION_RC1], ['dsh-invariants', '0.1.2-rc.1', UNION_RC1],
    ['dsh-invariants', '0.1.3-alpha.1', UNION_RC1],
    ['dsh-tools', '0.0.1-rc.1', UNION_RC1], ['dsh-tools', '0.0.1-rc.3', UNION_RC1],
    ['dsh-tools', '0.0.1-rc.5', UNION_RC1], ['dsh-tools', '0.1.0-rc.6', UNION_RC1],
    ['dsh-tools', '0.1.0-rc.8', UNION_RC1], ['dsh-tools', '0.1.1-rc.2', UNION_RC1],
    ['dsh-tools', '0.1.2-alpha.5', UNION_RC1], ['dsh-tools', '0.1.2-rc.1', UNION_RC1],
    ['dsh-tools', '0.1.3-alpha.1', UNION_RC1],
    // 0.1.x stable members are covered by the >=0.1.0-0 member
    ['dsh-invariants', '0.1.0', UNION_RC1], ['dsh-invariants', '0.1.4', UNION_RC1],
  ])('%s %s → true', (_pkg, version, range) => {
    expect(semver.satisfies(version, range)).toBe(true)
  })

  it.each([
    // below floor / future lines must stay out
    ['dsh-invariants', '0.0.1-rc.0', UNION_RC1],
    ['dsh-invariants', '0.2.0-alpha.1', UNION_RC1],
    ['dsh-invariants', '0.2.0', UNION_RC1],
    ['dsh-tools', '0.0.1-rc.0', UNION_RC1],
    ['dsh-tools', '0.2.0-alpha.1', UNION_RC1],
    ['dsh-tools', '0.2.0', UNION_RC1],
  ])('%s %s → false', (_pkg, version, range) => {
    expect(semver.satisfies(version, range)).toBe(false)
  })

  it('cordis >=4.0.1 accepts the stable 4.0.x line', () => {
    // non-null assertion: the union-assertion test above already pins the exact string
    for (const v of ['4.0.1', '4.0.2']) expect(semver.satisfies(v, peers['@deepseek-ai/cordis']!)).toBe(true)
  })
})
