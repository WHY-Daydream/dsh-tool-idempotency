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
/** 工具结果中「确定未提交」的证据码（failed_safe）。 */
export const NOT_COMMITTED_CODE = 'IDEMPOTENCY_NOT_COMMITTED';
/**
 * Dependency-free store. `now` injectable for TTL tests.
 */
export class MemoryStore {
    executing = new Map();
    cache = new Map();
    unknown = new Map();
    generations = new Map();
    maxEntries;
    maxInFlight;
    now;
    nextOwner = 1;
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
     * Look up a key. executing > unknown > succeeded（succeeded 按 TTL 惰性过期；
     * unknown 无过期——不自动回到可重执行）。
     */
    get(key) {
        const live = this.executing.get(key);
        if (live !== undefined)
            return live;
        const unk = this.unknown.get(key);
        if (unk !== undefined)
            return unk;
        const cached = this.cache.get(key);
        if (cached === undefined)
            return undefined;
        if (this.now() > cached.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return cached;
    }
    /**
     * Reserve an in-flight slot. The entry records the key's current generation;
     * a later invalidate/release bumps it, so this claim's settle becomes stale.
     */
    reserve(key, fingerprint) {
        if (this.executing.has(key)) {
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
        promise.catch(() => undefined);
        this.executing.set(key, {
            state: 'executing',
            owner,
            fingerprint,
            createdAt: this.now(),
            generation: this.generationOf(key),
            promise,
            resolve,
            reject,
        });
        return { owner, promise };
    }
    /**
     * Settle an execution. Success → succeeded 缓存；带 NOT_COMMITTED 证据的错误 →
     * failed_safe（释放即可，重试允许）；其余错误 → unknown 墓碑（重试被阻止）。
     * 代次不匹配（失效通知与旧执行并发）→ 释放但不写任何记录。
     */
    settle(key, owner, result, ttlMs) {
        const live = this.take(key, owner);
        if (live === undefined)
            return;
        live.resolve(result);
        if (live.generation !== this.generationOf(key)) {
            // 过期代次：不得把旧执行结果写回已失效/已解除的状态
            return;
        }
        if (!result.isError) {
            this.cacheResult(key, owner, live.fingerprint, result, ttlMs);
            this.unknown.delete(key);
        }
        else if (result.error?.info?.code === NOT_COMMITTED_CODE) {
            // failed_safe：有证据确定未提交 → 无记录，重试重新执行
        }
        else {
            this.writeUnknown(key, live.fingerprint);
        }
    }
    /** Thrown failure → unknown 墓碑（无提交证据），代次不匹配则不写。 */
    fail(key, owner, error) {
        const live = this.take(key, owner);
        if (live === undefined)
            return;
        live.reject(error);
        if (live.generation !== this.generationOf(key))
            return;
        this.writeUnknown(key, live.fingerprint);
    }
    /** 仅清除 succeeded 缓存 + 递增代次（补偿流程用；unknown 由 release/confirm 处理）。 */
    invalidate(key) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.cache.delete(key);
    }
    /** 状态解除：递增代次并清除 succeeded 与 unknown（下游对账后，后续同 key 重新执行）。 */
    release(key) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.cache.delete(key);
        this.unknown.delete(key);
    }
    /** 下游确认已提交：写入验证过的 succeeded 结果（可重放），并递增代次防旧写回。 */
    confirm(key, fingerprint, result, ttlMs) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.unknown.delete(key);
        this.cacheResult(key, 0, fingerprint, result, ttlMs);
    }
    /** Drop a cached succeeded result (inFlightOnly forced re-execution). */
    delete(key) {
        this.cache.delete(key);
    }
    /** Total live records (executing locks + cache + unknown). */
    get size() {
        return this.executing.size + this.cache.size + this.unknown.size;
    }
    generationOf(key) {
        return this.generations.get(key) ?? 1;
    }
    /** Detach the live executing row if — and only if — `owner` still owns it. */
    take(key, owner) {
        const live = this.executing.get(key);
        if (live === undefined || live.owner !== owner)
            return undefined;
        this.executing.delete(key);
        return live;
    }
    /** Write an unknown tombstone (FIFO-capped; eviction loses the marker — documented). */
    writeUnknown(key, fingerprint) {
        this.unknown.set(key, {
            state: 'unknown',
            owner: 0,
            fingerprint,
            createdAt: this.now(),
            generation: this.generationOf(key),
        });
        if (this.unknown.size > this.maxEntries) {
            this.evictOldest(this.unknown);
        }
    }
    cacheResult(key, owner, fingerprint, result, ttlMs) {
        const now = this.now();
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
            generation: this.generationOf(key),
            result,
        });
        if (this.cache.size > this.maxEntries) {
            this.evictOldest(this.cache);
        }
    }
    evictOldest(table) {
        let oldestKey;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [candidate, value] of table) {
            if (value.createdAt < oldestAt) {
                oldestAt = value.createdAt;
                oldestKey = candidate;
            }
        }
        if (oldestKey !== undefined)
            table.delete(oldestKey);
    }
}
