/**
 * In-memory idempotency store (MVP). Succeeded entries expire lazily by TTL;
 * failed entries are evicted on read; the oldest entry is evicted (FIFO) when
 * `maxEntries` is exceeded.
 * @module @why-daydream/dsh-tool-idempotency/stores/memory
 */
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/** One key's lifecycle record inside the store. */
export interface StoreEntry {
    /** Lifecycle state of the key (see ARCHITECTURE.md §③). */
    state: 'executing' | 'succeeded' | 'failed';
    /** Request fingerprint bound to the key (same key + different fingerprint fails loud). */
    fingerprint: string;
    /** Wall-clock creation time (ms), used for FIFO eviction. */
    createdAt: number;
    /** Absolute expiry (ms); present while `state === 'succeeded'`. */
    expiresAt?: number;
    /** In-flight execution promise; present while `state === 'executing'`. */
    promise?: Promise<ToolExecutionResult>;
    /** Cached normalized result; present while `state === 'succeeded'`. */
    result?: ToolExecutionResult;
}
/**
 * Dependency-free `Map`-backed store with lazy expiry and a FIFO cap.
 * `now` is injectable so TTL tests do not sleep.
 */
export declare class MemoryStore {
    private readonly entries;
    private readonly maxEntries;
    private readonly now;
    constructor(maxEntries: number, now?: () => number);
    /**
     * Look up a key, evicting entries that are no longer reusable: failed
     * entries (retry must re-execute) and succeeded entries past their TTL.
     * @param key - idempotency key.
     * @returns the live entry, or `undefined` for a miss.
     */
    get(key: string): StoreEntry | undefined;
    /**
     * Insert or overwrite an entry, evicting the oldest entry (by `createdAt`)
     * first when the map is at capacity and the key is new.
     */
    put(key: string, entry: StoreEntry): void;
    /** Remove a key unconditionally. */
    delete(key: string): void;
    /** Number of live entries (diagnostics / tests). */
    get size(): number;
}
