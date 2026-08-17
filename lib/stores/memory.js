/**
 * In-memory idempotency store (MVP). Succeeded entries expire lazily by TTL;
 * failed entries are evicted on read; the oldest entry is evicted (FIFO) when
 * `maxEntries` is exceeded.
 * @module @why-daydream/dsh-tool-idempotency/stores/memory
 */
/**
 * Dependency-free `Map`-backed store with lazy expiry and a FIFO cap.
 * `now` is injectable so TTL tests do not sleep.
 */
export class MemoryStore {
    entries = new Map();
    maxEntries;
    now;
    constructor(maxEntries, now = Date.now) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`);
        }
        this.maxEntries = maxEntries;
        this.now = now;
    }
    /**
     * Look up a key, evicting entries that are no longer reusable: failed
     * entries (retry must re-execute) and succeeded entries past their TTL.
     * @param key - idempotency key.
     * @returns the live entry, or `undefined` for a miss.
     */
    get(key) {
        const entry = this.entries.get(key);
        if (entry === undefined)
            return undefined;
        if (entry.state === 'failed') {
            this.entries.delete(key);
            return undefined;
        }
        if (entry.state === 'succeeded' && entry.expiresAt !== undefined && this.now() > entry.expiresAt) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }
    /**
     * Insert or overwrite an entry, evicting the oldest entry (by `createdAt`)
     * first when the map is at capacity and the key is new.
     */
    put(key, entry) {
        if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
            let oldestKey;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [candidate, value] of this.entries) {
                if (value.createdAt < oldestAt) {
                    oldestAt = value.createdAt;
                    oldestKey = candidate;
                }
            }
            if (oldestKey !== undefined)
                this.entries.delete(oldestKey);
        }
        this.entries.set(key, entry);
    }
    /** Remove a key unconditionally. */
    delete(key) {
        this.entries.delete(key);
    }
    /** Number of live entries (diagnostics / tests). */
    get size() {
        return this.entries.size;
    }
}
