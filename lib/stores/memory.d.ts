/**
 * In-memory idempotency store (MVP, P0-hardened).
 *
 * Two budgets keep the duplicate-execution lock independent of the result
 * cache:
 * - `executing` table — one entry per in-flight guarded execution. Entries are
 *   never evicted by cache pressure: evicting an in-flight lock would let a
 *   retry duplicate a side effect (P0). `maxInFlight` bounds this table and a
 *   saturated table refuses new claims instead of running unprotected.
 * - `cache` (succeeded) — replayed within TTL, FIFO-evicted oldest-first when
 *   over `maxEntries`.
 *
 * Settlements are owner-scoped: only the claim (`owner`) that holds a key may
 * settle or release it, so a stale or late completion can never overwrite or
 * delete a newer record for the same key. In-flight locks are released only by
 * `settle`/`fail`; `delete` drops cached results and never touches a live lock.
 * @module @why-daydream/dsh-tool-idempotency/stores/memory
 */
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/** One key's lifecycle record, as observed through {@link MemoryStore.get}. */
export interface StoreEntry {
    /** `executing` while the claim is in flight; `succeeded` while cached for replay. */
    state: 'executing' | 'succeeded';
    /** Identity of the claim that owns this record (stale settlements are ignored). */
    owner: number;
    /** Request fingerprint bound to the key (same key + different fingerprint fails loud). */
    fingerprint: string;
    /** Wall-clock creation time (ms), used for FIFO eviction of the cache. */
    createdAt: number;
    /** Absolute expiry (ms); present while `state === 'succeeded'`. */
    expiresAt?: number;
    /** In-flight execution promise; present while `state === 'executing'`. */
    promise?: Promise<ToolExecutionResult>;
    /** Cached normalized result; present while `state === 'succeeded'`. */
    result?: ToolExecutionResult;
}
/** A successfully reserved in-flight slot. */
export interface Reservation {
    /** Owner token to present when settling the reservation. */
    owner: number;
    /** Join promise: settles with the execution's outcome when it settles. */
    promise: Promise<ToolExecutionResult>;
}
/**
 * Dependency-free store with lazy cache expiry, a FIFO succeeded-cache cap and
 * an independent in-flight cap. `now` is injectable so TTL tests do not sleep.
 */
export declare class MemoryStore {
    private readonly executing;
    private readonly cache;
    private readonly maxEntries;
    private readonly maxInFlight;
    private readonly now;
    private nextOwner;
    /**
     * @param maxEntries - succeeded-result cache cap (FIFO eviction; never affects in-flight locks).
     * @param maxInFlight - simultaneous in-flight execution cap; overflow is refused, not evicted.
     * @param now - clock for TTL / FIFO bookkeeping.
     */
    constructor(maxEntries: number, maxInFlight?: number, now?: () => number);
    /**
     * Look up a key. Executing locks are always live (an in-flight task must not
     * be re-entered by a cache-TTL decision). Succeeded entries past their TTL
     * are dropped lazily and read as a miss.
     * @param key - idempotency key.
     * @returns the live record, or `undefined` for a miss.
     */
    get(key: string): StoreEntry | undefined;
    /**
     * Reserve an in-flight slot for `key` and register the join promise.
     * @returns the reservation, or `null` when `maxInFlight` is saturated — the
     * caller must surface a capacity error and MUST NOT run the side effect.
     */
    reserve(key: string, fingerprint: string): Reservation | null;
    /**
     * Settle an execution with its result. `isError` results release the lock
     * without caching (a retry must re-execute); successful results release the
     * lock and cache for replay. Stale settlements — an owner that no longer
     * owns the key — are ignored.
     * @param key - idempotency key.
     * @param owner - owner token from {@link reserve}.
     * @param result - the tool result.
     * @param ttlMs - replay TTL applied to a successful cache write.
     */
    settle(key: string, owner: number, result: ToolExecutionResult, ttlMs: number): void;
    /**
     * Settle an execution that threw. Releases the lock and rejects the join
     * promise; stale failures are ignored so an old owner cannot delete a newer
     * record.
     */
    fail(key: string, owner: number, error: unknown): void;
    /**
     * Drop a cached succeeded result (cache invalidation before a forced
     * re-execution, e.g. `inFlightOnly`). In-flight locks are never removable
     * this way — they belong to their owner until `settle`/`fail`.
     */
    delete(key: string): void;
    /** Total live records (executing locks + cached results; expired cache rows count until lazily cleaned). */
    get size(): number;
    /** Detach the live executing row if — and only if — `owner` still owns it. */
    private take;
    /** Write a succeeded row into the cache, evicting oldest-first when over `maxEntries`. */
    private cacheResult;
}
