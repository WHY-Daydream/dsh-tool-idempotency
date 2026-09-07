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
import { fingerprintOf } from './canonicalize.js'
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
  /** Succeeded-result cache cap (default 1024); evicting the cache never touches in-flight locks. */
  maxEntries?: number
  /**
   * Simultaneous in-flight execution cap (default 256). When saturated, a new
   * guarded call is refused with a structured capacity error — it never runs
   * its side effect unprotected.
   */
  maxInFlight?: number
  /** Opt-in tool rules; an empty list leaves the plugin inert. */
  rules?: Rule[]
}

export const Config: z<Config> = z.object({
  ttl: z.number().default(3600),
  maxEntries: z.number().default(1024),
  maxInFlight: z.number().default(256),
  rules: z.array(z.object({
    tool: z.string(),
    mode: z.union(['reuse', 'inFlightOnly', 'off'] as const).default('reuse'),
    keyArg: z.string(),
  })).default([]),
})

/** Structured error code for same-key / different-arguments reuse. */
const KEY_MISMATCH = 'IDEMPOTENCY_KEY_MISMATCH'
/** Structured error code for a refused claim (in-flight capacity exhausted). */
const CAPACITY_REJECTED = 'IDEMPOTENCY_CAPACITY_REJECTED'

/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
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

/** Rejection carried by a joiner that leaves early because its own signal aborted. */
class JoinerAbortedError extends Error {
  constructor() {
    super('idempotency join aborted by caller signal')
    this.name = 'JoinerAbortedError'
  }
}

/**
 * Join an in-flight execution, but leave promptly when the joiner's own signal
 * aborts — without cancelling the owner or touching the store (settlement stays
 * owner-scoped). Matches ARCHITECTURE §④: an in-flight waiter that is aborted
 * should abandon the wait instead of hanging the cancelled turn.
 */
function joinExecution(
  ownerPromise: Promise<ToolExecutionResult>,
  signal: AbortSignal | undefined,
): Promise<ToolExecutionResult> {
  if (signal === undefined || signal.aborted) {
    return Promise.reject(new JoinerAbortedError())
  }
  return new Promise<ToolExecutionResult>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(new JoinerAbortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ownerPromise.then(
      (result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
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
  const maxInFlight = config.maxInFlight as number
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`dsh-tool-idempotency: invalid ttl ${ttlSeconds} — must be an integer >= 1 (seconds)`)
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`)
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`dsh-tool-idempotency: invalid maxInFlight ${maxInFlight} — must be an integer >= 1`)
  }
  const ttlMs = ttlSeconds * 1000
  const rules: CompiledRule[] = (config.rules as Rule[]).map(rule => {
    if (typeof rule.tool !== 'string' || rule.tool.length === 0) {
      throw new Error('dsh-tool-idempotency: every rule must declare a non-empty `tool` pattern')
    }
    return { regex: wildcardToRegExp(rule.tool), mode: rule.mode ?? 'reuse', keyArg: rule.keyArg }
  })

  const store = new MemoryStore(maxEntries, maxInFlight)

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
      // Abort-aware join: leave promptly if this caller's signal aborts while
      // the owner is still running — never cancel the owner or touch the store.
      return joinExecution(existing.promise as Promise<ToolExecutionResult>, exec.signal)
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

    // Fresh execution. Claim the in-flight slot synchronously before the tool
    // body can run, so two concurrent callers cannot both observe a miss.
    const reservation = store.reserve(key, fingerprint)
    if (reservation === null) {
      // In-flight capacity is exhausted. Refuse loudly instead of running the
      // side effect outside the guard or evicting an executing lock.
      return idempotencyError(
        `idempotency in-flight capacity reached (maxInFlight ${maxInFlight}) for tool \`${exec.name}\` — refusing the call; retry when a slot is free`,
        CAPACITY_REJECTED,
        'IdempotencyCapacityRejected',
      )
    }
    const owner = reservation.owner

    const promise = (async (): Promise<ToolExecutionResult> => {
      try {
        const result = await next()
        // settle: success caches for replay; isError releases the lock without
        // caching (a retry must re-execute). Owner-scoped: a stale completion
        // can never overwrite or delete a newer record.
        store.settle(key, owner, result, ttlMs)
        return result
      } catch (error) {
        store.fail(key, owner, error)
        throw error
      }
    })()
    return promise
  })
}
