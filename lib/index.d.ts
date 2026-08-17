/**
 * Idempotency / duplicate-execution guard for DeepSeek Harness tool calls.
 *
 * Opted-in tools (see ARCHITECTURE.md §②) are deduplicated by idempotency
 * key: concurrent duplicates join the in-flight execution, later retries
 * reuse the cached result within the TTL, and a key reused with different
 * arguments fails loud instead of executing a conflicting side effect.
 * @module @why-daydream/dsh-tool-idempotency
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
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
    /** MemoryStore entry cap (default 1024). */
    maxEntries?: number;
    /** Opt-in tool rules; an empty list leaves the plugin inert. */
    rules?: Rule[];
}
export declare const Config: z<Config>;
/**
 * Install the idempotency guard.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export declare function apply(ctx: Context, config: Config): void;
