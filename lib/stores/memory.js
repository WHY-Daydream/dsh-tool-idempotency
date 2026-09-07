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
/**
 * Dependency-free store with lazy cache expiry, a FIFO succeeded-cache cap and
 * an independent in-flight cap. `now` is injectable so TTL tests do not sleep.
 */
export class MemoryStore {
    executing = new Map();
    cache = new Map();
    maxEntries;
    maxInFlight;
    now;
    nextOwner = 1;
    /**
     * @param maxEntries - succeeded-result cache cap (FIFO eviction; never affects in-flight locks).
     * @param maxInFlight - simultaneous in-flight execution cap; overflow is refused, not evicted.
     * @param now - clock for TTL / FIFO bookkeeping.
     */
    constructor(maxEntries, maxInFlight = 256, now = Date.now) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`);
        }
        if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxInFlight ${maxInFlight} — must be an integer >= 1`);
        }
        this.maxEntries = maxEntries;
        this.maxInFlight = maxInFlight;
        this.now = now;
    }
    /**
     * Look up a key. Executing locks are always live (an in-flight task must not
     * be re-entered by a cache-TTL decision). Succeeded entries past their TTL
     * are dropped lazily and read as a miss.
     * @param key - idempotency key.
     * @returns the live record, or `undefined` for a miss.
     */
    get(key) {
        const live = this.executing.get(key);
        if (live !== undefined)
            return live;
        const cached = this.cache.get(key);
        if (cached === undefined)
            return undefined;
        if (cached.expiresAt !== undefined && this.now() > cached.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return cached;
    }
    /**
     * Reserve an in-flight slot for `key` and register the join promise.
     * @returns the reservation, or `null` when `maxInFlight` is saturated — the
     * caller must surface a capacity error and MUST NOT run the side effect.
     */
    reserve(key, fingerprint) {
        if (this.executing.has(key)) {
            // Unreachable through the plugin listener (join / mismatch short-circuit
            // first). Two live claims for one key would fork the side effect, so
            // fail loud rather than let that happen silently.
            throw new Error(`dsh-tool-idempotency: duplicate in-flight claim for key ${JSON.stringify(key)} — join the existing execution instead of claiming again`);
        }
        if (this.executing.size >= this.maxInFlight)
            return null;
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const owner = this.nextOwner;
        this.nextOwner += 1;
        // Mark the join promise as handled at the source: when the claiming call
        // fails with no joiner attached, `fail` rejecting this promise must not
        // surface as an ambient unhandled rejection. Joiners awaiting the same
        // promise still receive the rejection normally.
        promise.catch(() => undefined);
        this.executing.set(key, {
            state: 'executing',
            owner,
            fingerprint,
            createdAt: this.now(),
            promise,
            resolve,
            reject,
        });
        return { owner, promise };
    }
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
    settle(key, owner, result, ttlMs) {
        const live = this.take(key, owner);
        if (live === undefined)
            return;
        live.resolve(result);
        if (!result.isError)
            this.cacheResult(key, owner, live.fingerprint, result, ttlMs);
    }
    /**
     * Settle an execution that threw. Releases the lock and rejects the join
     * promise; stale failures are ignored so an old owner cannot delete a newer
     * record.
     */
    fail(key, owner, error) {
        const live = this.take(key, owner);
        if (live === undefined)
            return;
        live.reject(error);
    }
    /**
     * Drop a cached succeeded result (cache invalidation before a forced
     * re-execution, e.g. `inFlightOnly`). In-flight locks are never removable
     * this way — they belong to their owner until `settle`/`fail`.
     */
    delete(key) {
        this.cache.delete(key);
    }
    /** Total live records (executing locks + cached results; expired cache rows count until lazily cleaned). */
    get size() {
        return this.executing.size + this.cache.size;
    }
    /** Detach the live executing row if — and only if — `owner` still owns it. */
    take(key, owner) {
        const live = this.executing.get(key);
        if (live === undefined || live.owner !== owner)
            return undefined;
        this.executing.delete(key);
        return live;
    }
    /** Write a succeeded row into the cache, evicting oldest-first when over `maxEntries`. */
    cacheResult(key, owner, fingerprint, result, ttlMs) {
        const now = this.now();
        // Expired rows no longer deserve budget: drop them before capacity checks.
        for (const [candidate, value] of this.cache) {
            if (now > value.expiresAt)
                this.cache.delete(candidate);
        }
        this.cache.set(key, {
            state: 'succeeded',
            owner,
            fingerprint,
            createdAt: now,
            expiresAt: now + ttlMs,
            result,
        });
        if (this.cache.size > this.maxEntries) {
            let oldestKey;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [candidate, value] of this.cache) {
                if (value.createdAt < oldestAt) {
                    oldestAt = value.createdAt;
                    oldestKey = candidate;
                }
            }
            if (oldestKey !== undefined)
                this.cache.delete(oldestKey);
        }
    }
}
