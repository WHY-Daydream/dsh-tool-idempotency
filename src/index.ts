/**
 * Idempotency / duplicate-execution guard for DeepSeek Harness tool calls
 * (0.2.0: unknown 状态机 + Saga 缓存失效).
 *
 * Opted-in tools are deduplicated by idempotency key: concurrent duplicates
 * join the in-flight execution, later retries reuse the cached result within
 * the TTL, and a key reused with different arguments fails loud.
 *
 * 0.2.0 行为变化：不再把所有 `isError` 都解释为「可以重新执行」。
 * - 成功结果 → `succeeded`：TTL 内按策略重放。
 * - 带 `error.info.code === 'IDEMPOTENCY_NOT_COMMITTED'` 证据的错误 → `failed_safe`：
 *   确定未提交，重试允许重新执行。
 * - 其余错误（无提交证据，含超时/abort/普通抛错）→ `unknown`：阻止自动重执行，
 *   需经 `ctx.toolIdempotency` 的 query/confirm/release 或下游对账后解除。
 *   unknown 不随 TTL 自动回到可重执行。
 * - `invalidate`（补偿流程）：清除 succeeded 缓存并递增代次，防止旧执行把
 *   已失效结果写回（owner+代次校验）。「仅删除缓存≠可安全重执行」——补偿后
 *   业务需结合新操作身份（新 key）决定后续动作。
 * @module @why-daydream/dsh-tool-idempotency
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { fingerprintOf } from './canonicalize.js'
import { MemoryStore, NOT_COMMITTED_CODE } from './stores/memory.js'

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
  /** Succeeded-result cache cap (default 1024); evicting the cache never touches
   *  in-flight locks, and unknown tombstones are exempt from this cap. */
  maxEntries?: number
  /**
   * Unknown-tombstone budget (default 1024). Tombstones are **never evicted**
   * (eviction would silently re-open the duplicate-side-effect window); the
   * budget counts **concurrency-reserved** capacity — `unknown + in-flight ≤
   * maxUnknown` — so a burst of concurrent calls that all fail can never
   * exceed the cap. When the budget is exhausted, new guarded executions are
   * refused up front with `IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED`; reconcile
   * unknown keys (`release`/`confirm`) to free budget.
   */
  maxUnknown?: number
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
  maxUnknown: z.number().default(1024),
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
/** Structured error code for an auto-retry blocked by an unknown commit state. */
const STATE_UNKNOWN = 'IDEMPOTENCY_STATE_UNKNOWN'
/** Structured error code for a refused claim (unknown-tombstone budget exhausted). */
const UNKNOWN_CAPACITY_REJECTED = 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED'
/** Structured error code for a reconcile rejected by the execution fence
 *  (expectedExecutionId stale/ABA — old reconcile must never hit a newer execution).
 *  校验对象已是 executionId，名称沿袭 generation 时代（已在兼容面，保留不动；
 *  未来如需可新增 IDEMPOTENCY_EXECUTION_MISMATCH 或随大版本调整）。 */
const GENERATION_MISMATCH = 'IDEMPOTENCY_GENERATION_MISMATCH'

/** 0.2.0 状态查询/解除/失效接口（挂载于 ctx.toolIdempotency）。 */
export interface ToolIdempotencyApi {
  /** 查询 key 的当前状态（executing/succeeded/unknown），无记录返回 undefined。
   *  `executionId` 为当前记录所属执行的 **execution-scoped stale-operation fence /
   *  CAS identity token**（每轮执行唯一、不复用；异步对账回传 `expectedExecutionId`
   *  唯一锁定该轮执行——旧对账结果（ABA）永远无法作用于新一轮执行）。 */
  query(name: string, argumentsValue: Record<string, unknown>): {
    state: 'executing' | 'succeeded' | 'unknown'
    fingerprint: string
    executionId: string
    expiresAt?: number | undefined
  } | undefined
  /** 状态解除：下游对账确认无未决提交后，清除 succeeded/unknown，后续同 key 可重新执行。
   *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数（另一请求）或
   *  旧执行（ABA）时拒绝且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。 */
  release(
    name: string,
    argumentsValue: Record<string, unknown>,
    options?: { expectedExecutionId?: string },
  ): { ok: boolean; error?: string }
  /** 下游确认已提交：以验证过的结果写入 succeeded（可重放），并递增代次。
   *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数/旧执行时拒绝
   *  且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。
   *  注意：result 需为宿主导管可校验的完整物化形状（isError/content/value），
   *  与正常执行返回的结果一致。 */
  confirm(
    name: string,
    argumentsValue: Record<string, unknown>,
    result: ToolExecutionResult,
    options?: { expectedExecutionId?: string },
  ): { ok: boolean; error?: string }
  /** 补偿流程：清除 succeeded 缓存并递增代次（仅删除缓存≠可安全重执行，需结合业务状态）。
   *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数/旧执行时拒绝
   *  且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。 */
  invalidate(
    name: string,
    argumentsValue: Record<string, unknown>,
    options?: { expectedExecutionId?: string },
  ): { ok: boolean; error?: string }
}

/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Resolve the idempotency key: explicit `keyArg` value, else the request fingerprint. */
function resolveKey(name: string, argumentsValue: Record<string, unknown>, keyArg: string | undefined): string {
  if (keyArg !== undefined) {
    const value = (argumentsValue as Record<string, unknown> | null)?.[keyArg]
    if (typeof value === 'string' && value.length > 0) return `explicit:${value}`
  }
  return `fp:${fingerprintOf({ name, arguments: argumentsValue } as ToolExecution)}`
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
 * Install the idempotency guard (0.2.0).
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export function apply(ctx: Context, config: Config): void {
  const ttlSeconds = config.ttl as number
  const maxEntries = config.maxEntries as number
  const maxUnknown = config.maxUnknown as number
  const maxInFlight = config.maxInFlight as number
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`dsh-tool-idempotency: invalid ttl ${ttlSeconds} — must be an integer >= 1 (seconds)`)
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`)
  }
  if (!Number.isInteger(maxUnknown) || maxUnknown < 1) {
    throw new Error(`dsh-tool-idempotency: invalid maxUnknown ${maxUnknown} — must be an integer >= 1`)
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

  const store = new MemoryStore(maxEntries, maxInFlight, maxUnknown)

  /** API 用 key 解析：命中规则（非 off）才有效。 */
  function resolveApiKey(name: string, argumentsValue: Record<string, unknown>): string | undefined {
    const rule = rules.find(candidate => candidate.regex.test(name))
    if (rule === undefined || rule.mode === 'off') return undefined
    return resolveKey(name, argumentsValue, rule.keyArg)
  }

  // 0.2.0：挂载状态查询/解除/失效接口（补偿流程与对账使用）。
  // cordis Context 是容器代理：provide 声明并赋值一步完成（返回 disposer，fiber 卸载时自动清理）。
  const api: ToolIdempotencyApi = {
    query(name, argumentsValue) {
      const key = resolveApiKey(name, argumentsValue)
      if (key === undefined) return undefined
      const entry = store.get(key)
      if (entry === undefined) return undefined
      return { state: entry.state, fingerprint: entry.fingerprint, executionId: entry.executionId, expiresAt: entry.expiresAt }
    },
    release(name, argumentsValue, options) {
      const key = resolveApiKey(name, argumentsValue)
      if (key === undefined) {
        return { ok: false, error: `tool \`${name}\` is not guarded by any idempotency rule` }
      }
      const fingerprint = fingerprintOf({ name, arguments: argumentsValue } as ToolExecution)
      const accepted = store.release(key, fingerprint, options?.expectedExecutionId)
      return accepted
        ? { ok: true }
        : {
            ok: false,
            error:
              `idempotency key fingerprint mismatch or stale executionId (${GENERATION_MISMATCH}) — refusing to release a record owned by different arguments or an older execution (ABA); re-query to obtain the current executionId`,
          }
    },
    confirm(name, argumentsValue, result, options) {
      const key = resolveApiKey(name, argumentsValue)
      if (key === undefined) {
        return { ok: false, error: `tool \`${name}\` is not guarded by any idempotency rule` }
      }
      const fingerprint = fingerprintOf({ name, arguments: argumentsValue } as ToolExecution)
      const accepted = store.confirm(key, fingerprint, result, ttlMs, options?.expectedExecutionId)
      return accepted
        ? { ok: true }
        : {
            ok: false,
            error:
              `idempotency key fingerprint mismatch or stale executionId (${GENERATION_MISMATCH}) — refusing to confirm a record owned by different arguments or an older execution (ABA)`,
          }
    },
    invalidate(name, argumentsValue, options) {
      const key = resolveApiKey(name, argumentsValue)
      if (key === undefined) {
        return { ok: false, error: `tool \`${name}\` is not guarded by any idempotency rule` }
      }
      const fingerprint = fingerprintOf({ name, arguments: argumentsValue } as ToolExecution)
      const accepted = store.invalidate(key, fingerprint, options?.expectedExecutionId)
      return accepted
        ? { ok: true }
        : {
            ok: false,
            error:
              `idempotency key fingerprint mismatch or stale executionId (${GENERATION_MISMATCH}) — refusing to invalidate a record owned by different arguments or an older execution (ABA)`,
          }
    },
  }
  // 同一 ctx 重复挂载同一插件时只提供一次服务（避免 provide 同名冲突）。
  if (ctx.get('toolIdempotency') === undefined) {
    ctx.provide('toolIdempotency', api)
  }

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const rule = rules.find(candidate => candidate.regex.test(exec.name))
    if (rule === undefined || rule.mode === 'off') return next()

    const key = resolveKey(exec.name, exec.arguments as Record<string, unknown>, rule.keyArg)
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
      // 0.2.0：store.join —— abort-aware 且**可脱离**（waiter 集合管理，abort 即移除，
      // 不在 owner promise 上累积 .then 处理器；owner 结算时批量结算）。
      return store.join(key, exec.signal)
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
        return existing.result as ToolExecutionResult
      }
      // inFlightOnly: never replay a cached result — execute again.
      store.delete(key)
    }

    if (existing !== undefined && existing.state === 'unknown') {
      if (existing.fingerprint !== fingerprint) {
        return idempotencyError(
          `idempotency key \`${key}\` is in unknown state with different arguments — refusing the conflicting call`,
          KEY_MISMATCH,
          'IdempotencyKeyMismatch',
        )
      }
      // 0.2.0：unknown 不自动重执行（不随 TTL 自动解除）。需下游对账后
      // release/confirm，或改用新的操作身份（新 key）。
      return idempotencyError(
        `idempotency key \`${key}\` is in UNKNOWN state — cannot determine whether the side effect committed; do NOT blindly re-execute; reconcile downstream, then release/confirm via ctx.toolIdempotency, or retry with a new operation identity`,
        STATE_UNKNOWN,
        'IdempotencyStateUnknown',
      )
    }

    // Fresh execution. Claim the in-flight slot synchronously before the tool
    // body can run, so two concurrent callers cannot both observe a miss.
    // 墓碑预算耗尽时**前置拒绝**：不淘汰旧 unknown，也不让副作用在没有「失败后
    // 可记录位置」的情况下执行。
    if (store.unknownFull) {
      return idempotencyError(
        `idempotency unknown-state budget reached (maxUnknown ${maxUnknown}) for tool \`${exec.name}\` — refusing the call; reconcile unknown keys via release/confirm, then retry`,
        UNKNOWN_CAPACITY_REJECTED,
        'IdempotencyUnknownCapacityRejected',
      )
    }
    const reservation = store.reserve(key, fingerprint)
    if (reservation === null) {
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
        // 0.2.0：store.settle 按提交证据分类（succeeded/failed_safe/unknown）。
        // owner+代次校验：失效通知与旧执行并发时，陈旧完成不写回。
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

export { NOT_COMMITTED_CODE } from './stores/memory.js'
