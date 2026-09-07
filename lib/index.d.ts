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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
export declare const name = "tool-idempotency";
/** Guard behavior for matched tools. */
export type RuleMode = 'reuse' | 'inFlightOnly' | 'off';
/** One opt-in tool rule. */
export interface Rule {
    /** `*`-wildcard tool-name pattern; the first matching rule wins. */
    tool: string;
    /**
     * `reuse` (default): deduplicate and replay the cached result.
     * `inFlightOnly`: irreversible tools — join concurrent calls, never replay a
     * cached result (the first execution may already have taken effect).
     * `off`: explicitly disable the guard for matched tools.
     */
    mode?: RuleMode;
    /** Explicit idempotency-key argument name; absent → request fingerprint. */
    keyArg?: string;
}
/** Plugin config. */
export interface Config {
    /** Cached-result TTL in seconds (default 3600). */
    ttl?: number;
    /** Succeeded-result cache cap (default 1024); evicting the cache never touches
     *  in-flight locks, and unknown tombstones are exempt from this cap. */
    maxEntries?: number;
    /**
     * Unknown-tombstone budget (default 1024). Tombstones are **never evicted**
     * (eviction would silently re-open the duplicate-side-effect window); the
     * budget counts **concurrency-reserved** capacity — `unknown + in-flight ≤
     * maxUnknown` — so a burst of concurrent calls that all fail can never
     * exceed the cap. When the budget is exhausted, new guarded executions are
     * refused up front with `IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED`; reconcile
     * unknown keys (`release`/`confirm`) to free budget.
     */
    maxUnknown?: number;
    /**
     * Simultaneous in-flight execution cap (default 256). When saturated, a new
     * guarded call is refused with a structured capacity error — it never runs
     * its side effect unprotected.
     */
    maxInFlight?: number;
    /** Opt-in tool rules; an empty list leaves the plugin inert. */
    rules?: Rule[];
}
export declare const Config: z<Config>;
/** 0.2.0 状态查询/解除/失效接口（挂载于 ctx.toolIdempotency）。 */
export interface ToolIdempotencyApi {
    /** 查询 key 的当前状态（executing/succeeded/unknown），无记录返回 undefined。
     *  `executionId` 为当前记录所属执行的 **fencing token**（每轮执行唯一、永不回退；
     *  异步对账回传 `expectedExecutionId` 唯一锁定该轮执行——旧对账结果（ABA）永远
     *  无法作用于新一轮执行）。 */
    query(name: string, argumentsValue: Record<string, unknown>): {
        state: 'executing' | 'succeeded' | 'unknown';
        fingerprint: string;
        executionId: string;
        expiresAt?: number | undefined;
    } | undefined;
    /** 状态解除：下游对账确认无未决提交后，清除 succeeded/unknown，后续同 key 可重新执行。
     *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数（另一请求）或
     *  旧执行（ABA）时拒绝且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。 */
    release(name: string, argumentsValue: Record<string, unknown>, options?: {
        expectedExecutionId?: string;
    }): {
        ok: boolean;
        error?: string;
    };
    /** 下游确认已提交：以验证过的结果写入 succeeded（可重放），并递增代次。
     *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数/旧执行时拒绝
     *  且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。
     *  注意：result 需为宿主导管可校验的完整物化形状（isError/content/value），
     *  与正常执行返回的结果一致。 */
    confirm(name: string, argumentsValue: Record<string, unknown>, result: ToolExecutionResult, options?: {
        expectedExecutionId?: string;
    }): {
        ok: boolean;
        error?: string;
    };
    /** 补偿流程：清除 succeeded 缓存并递增代次（仅删除缓存≠可安全重执行，需结合业务状态）。
     *  **校验 fingerprint + expectedExecutionId**：已有记录属于不同参数/旧执行时拒绝
     *  且保持原状态（`IDEMPOTENCY_GENERATION_MISMATCH`）。 */
    invalidate(name: string, argumentsValue: Record<string, unknown>, options?: {
        expectedExecutionId?: string;
    }): {
        ok: boolean;
        error?: string;
    };
}
/**
 * Install the idempotency guard (0.2.0).
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export declare function apply(ctx: Context, config: Config): void;
export { NOT_COMMITTED_CODE } from './stores/memory.js';
