/**
 * Idempotency / duplicate-execution guard for DeepSeek Harness tool calls.
 *
 * Opted-in tools (see ARCHITECTURE.md §②) are deduplicated by idempotency
 * key: concurrent duplicates join the in-flight execution, later retries
 * reuse the cached result within the TTL, and a key reused with different
 * arguments fails loud instead of executing a conflicting side effect.
 * @module @why-daydream/dsh-tool-idempotency
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './stores/memory.js'

export const name = 'tool-idempotency'

/** Guard behavior for matched tools. */
export type RuleMode = 'reuse' | 'inFlightOnly' | 'off'

/** One opt-in tool rule. */
export interface Rule {
  /** `*`-wildcard tool-name pattern; the first matching rule wins. */
  tool: string
  /**
   * `reuse` (default): deduplicate and replay the cached result.
   * `inFlightOnly`: irreversible tools — join concurrent calls, never replay a
   * cached result (the first execution may already have taken effect).
   * `off`: explicitly disable the guard for matched tools.
   */
  mode?: RuleMode
  /** Explicit idempotency-key argument name; absent → request fingerprint. */
  keyArg?: string
}

/** Plugin config. */
export interface Config {
  /** Cached-result TTL in seconds (default 3600). */
  ttl?: number
  /** MemoryStore entry cap (default 1024). */
  maxEntries?: number
  /** Opt-in tool rules; an empty list leaves the plugin inert. */
  rules?: Rule[]
}

export const Config: z<Config> = z.object({
  ttl: z.number().default(3600),
  maxEntries: z.number().default(1024),
  rules: z.array(z.object({
    tool: z.string(),
    mode: z.union(['reuse', 'inFlightOnly', 'off'] as const).default('reuse'),
    keyArg: z.string(),
  })).default([]),
})

/** Structured error code for same-key / different-arguments reuse. */
const KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH'

/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Deep key-sort of a parsed-JSON value so argument objects differing only in
 * property order canonicalize identically (same idiom as
 * `@deepseek-ai/dsh-repeat-tool-reminder`).
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Deterministic FNV-1a 32-bit hash (hex) — dependency-free request fingerprinting. */
function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Request fingerprint: hash of tool name + canonicalized arguments. */
function fingerprintOf(exec: ToolExecution): string {
  const canonical = JSON.stringify(sortJsonValue(exec.arguments))
  return hashString(`${exec.name}\u0000${canonical}`)
}

/** Resolve the idempotency key: explicit `keyArg` value, else the request fingerprint. */
function resolveKey(exec: ToolExecution, keyArg: string | undefined): string {
  if (keyArg !== undefined) {
    const value = (exec.arguments as Record<string, unknown> | null)?.[keyArg]
    if (typeof value === 'string' && value.length > 0) return `explicit:${value}`
  }
  return `fp:${fingerprintOf(exec)}`
}

/** Build one structured `isError` tool result (same shape as dsh-chaos). */
function idempotencyError(message: string, code: string, errorName: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: errorName, code } },
  }
}

/** A rule compiled for matching. */
interface CompiledRule {
  regex: RegExp
  mode: RuleMode
  keyArg: string | undefined
}

/**
 * Install the idempotency guard.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export function apply(ctx: Context, config: Config): void {
  const ttlSeconds = config.ttl as number
  const maxEntries = config.maxEntries as number
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`dsh-tool-idempotency: invalid ttl ${ttlSeconds} — must be an integer >= 1 (seconds)`)
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`)
  }
  const ttlMs = ttlSeconds * 1000
  const rules: CompiledRule[] = (config.rules as Rule[]).map(rule => {
    if (typeof rule.tool !== 'string' || rule.tool.length === 0) {
      throw new Error('dsh-tool-idempotency: every rule must declare a non-empty `tool` pattern')
    }
    return { regex: wildcardToRegExp(rule.tool), mode: rule.mode ?? 'reuse', keyArg: rule.keyArg }
  })

  const store = new MemoryStore(maxEntries)

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const rule = rules.find(candidate => candidate.regex.test(exec.name))
    if (rule === undefined || rule.mode === 'off') return next()

    const key = resolveKey(exec, rule.keyArg)
    const fingerprint = fingerprintOf(exec)
    const existing = store.get(key)

    if (existing !== undefined && existing.state === 'executing') {
      // Concurrent duplicate: join the in-flight execution instead of running
      // the side effect a second time.
      if (existing.fingerprint !== fingerprint) {
        return idempotencyError(
          `idempotency key \`${key}\` is already executing with different arguments — refusing the conflicting call`,
          KEY_MISMATCH,
          'IdempotencyKeyMismatch',
        )
      }
      return existing.promise as Promise<ToolExecutionResult>
    }

    if (existing !== undefined && existing.state === 'succeeded') {
      if (existing.fingerprint !== fingerprint) {
        return idempotencyError(
          `idempotency key \`${key}\` already completed with different arguments — refusing the conflicting call`,
          KEY_MISMATCH,
          'IdempotencyKeyMismatch',
        )
      }
      if (rule.mode === 'reuse') {
        // Replay the cached result; the side effect does not happen again.
        return existing.result as ToolExecutionResult
      }
      // inFlightOnly: never replay a cached result — execute again.
      store.delete(key)
    }

    // Fresh execution. The key is claimed in the same synchronous tick as the
    // promise is created (the tool body only continues on later microtasks),
    // so two concurrent callers cannot both observe a miss.
    const promise = (async (): Promise<ToolExecutionResult> => {
      try {
        const result = await next()
        if (result.isError) {
          store.delete(key) // FAILED: a retry must re-execute.
        } else {
          store.put(key, {
            state: 'succeeded',
            fingerprint,
            createdAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
            result,
          })
        }
        return result
      } catch (error) {
        store.delete(key)
        throw error
      }
    })()
    store.put(key, { state: 'executing', fingerprint, createdAt: Date.now(), promise })
    return promise
  })
}
