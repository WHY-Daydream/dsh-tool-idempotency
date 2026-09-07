/**
 * In-memory idempotency store (0.2.0: unknown 状态机 + 代次保护).
 *
 * 状态模型：
 * - `executing` — 操作仍在执行；并发重复加入等待（join），执行锁不淘汰。
 * - `succeeded` — 已确认成功；TTL 内按策略重放（FIFO 上限 maxEntries）。
 * - `unknown` — 无法确定副作用是否已提交（失败但无「确定未提交」证据）。
 *   不自动过期、不自动重执行；仅通过显式 release/confirm 解除。FIFO 上限
 *   maxEntries（淘汰墓碑=丢失状态标记，需下游对账，文档已声明）。
 * - `failed_safe`（瞬态，不留记录）— 有证据确认未提交（error.info.code ===
 *   'IDEMPOTENCY_NOT_COMMITTED'）→ 释放锁，重试允许重新执行。
 *
 * 代次保护（0.2.0）：每个 key 维护一个代次号。invalidate/release/confirm 递增代次；
 * settle/fail 校验执行条目代次 === 当前代次，不一致（失效通知与旧执行并发）时
 * 释放但不写缓存/墓碑——旧执行不能把已失效的结果写回。
 *
 * 预算：executing 受 maxInFlight 限制（满则拒绝，不淘汰）；succeeded 与 unknown
 * 共享 maxEntries FIFO；二者独立于执行锁。
 */
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/** 工具结果中「确定未提交」的证据码（failed_safe）。 */
export declare const NOT_COMMITTED_CODE = "IDEMPOTENCY_NOT_COMMITTED";
/** One key's lifecycle record, as observed through {@link MemoryStore.get}. */
export interface StoreEntry {
    state: 'executing' | 'succeeded' | 'unknown';
    owner: number;
    fingerprint: string;
    createdAt: number;
    expiresAt?: number;
    promise?: Promise<ToolExecutionResult>;
    result?: ToolExecutionResult;
    generation: number;
}
/** A successfully reserved in-flight slot. */
export interface Reservation {
    owner: number;
    promise: Promise<ToolExecutionResult>;
}
/**
 * Dependency-free store. `now` injectable for TTL tests.
 */
export declare class MemoryStore {
    private readonly executing;
    private readonly cache;
    private readonly unknown;
    private readonly generations;
    private readonly maxEntries;
    private readonly maxInFlight;
    private readonly now;
    private nextOwner;
    constructor(maxEntries: number, maxInFlight?: number, now?: () => number);
    /**
     * Look up a key. executing > unknown > succeeded（succeeded 按 TTL 惰性过期；
     * unknown 无过期——不自动回到可重执行）。
     */
    get(key: string): StoreEntry | undefined;
    /**
     * Reserve an in-flight slot. The entry records the key's current generation;
     * a later invalidate/release bumps it, so this claim's settle becomes stale.
     */
    reserve(key: string, fingerprint: string): Reservation | null;
    /**
     * Settle an execution. Success → succeeded 缓存；带 NOT_COMMITTED 证据的错误 →
     * failed_safe（释放即可，重试允许）；其余错误 → unknown 墓碑（重试被阻止）。
     * 代次不匹配（失效通知与旧执行并发）→ 释放但不写任何记录。
     */
    settle(key: string, owner: number, result: ToolExecutionResult, ttlMs: number): void;
    /** Thrown failure → unknown 墓碑（无提交证据），代次不匹配则不写。 */
    fail(key: string, owner: number, error: unknown): void;
    /** 仅清除 succeeded 缓存 + 递增代次（补偿流程用；unknown 由 release/confirm 处理）。 */
    invalidate(key: string): void;
    /** 状态解除：递增代次并清除 succeeded 与 unknown（下游对账后，后续同 key 重新执行）。 */
    release(key: string): void;
    /** 下游确认已提交：写入验证过的 succeeded 结果（可重放），并递增代次防旧写回。 */
    confirm(key: string, fingerprint: string, result: ToolExecutionResult, ttlMs: number): void;
    /** Drop a cached succeeded result (inFlightOnly forced re-execution). */
    delete(key: string): void;
    /** Total live records (executing locks + cache + unknown). */
    get size(): number;
    private generationOf;
    /** Detach the live executing row if — and only if — `owner` still owns it. */
    private take;
    /** Write an unknown tombstone (FIFO-capped; eviction loses the marker — documented). */
    private writeUnknown;
    private cacheResult;
    private evictOldest;
}
