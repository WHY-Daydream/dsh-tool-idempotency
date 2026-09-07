/**
 * In-memory idempotency store (0.2.0: unknown 状态机 + 代次保护).
 *
 * 状态模型：
 * - `executing` — 操作仍在执行；并发重复加入等待（join），执行锁不淘汰。
 * - `succeeded` — 已确认成功；TTL 内按策略重放（FIFO 上限 maxEntries）。
 * - `unknown` — 无法确定副作用是否已提交（失败但无「确定未提交」证据）。
 *   不自动过期、不自动重执行；仅通过显式 release/confirm 解除。**不被容量淘汰**
 *   （墓碑是防重复副作用的唯一标记：淘汰=静默解除=延迟重复副作用；对账即生命周期）。
 * - `failed_safe`（瞬态，不留记录）— 有证据确认未提交（error.info.code ===
 *   'IDEMPOTENCY_NOT_COMMITTED'，结果或抛错均可）→ 释放锁，重试允许重新执行。
 *
 * 代次保护（0.2.0）：每个 key 维护一个代次号。invalidate/release/confirm 递增代次；
 * settle/fail 校验执行条目代次 === 当前代次，不一致（失效通知与旧执行并发）时
 * 释放但不写缓存/墓碑——旧执行不能把已失效的结果写回。
 *
 * 预算：executing 受 maxInFlight 限制（满则拒绝，不淘汰）；succeeded 受 maxEntries
 * FIFO 限制（只淘汰已完成项，不碰执行锁与 unknown 墓碑）；**unknown 墓碑受独立预算
 * maxUnknown 限制**（默认 1024）：墓碑**永不淘汰**（淘汰=静默解除=延迟重复副作用），
 * 且按**并发预留口径**计数（unknown + 在途执行 ≤ maxUnknown，杜绝「检查时未满、并发
 * 全部失败后突破预算」）；预算耗尽时 reserve 前置拒绝新执行（不淘汰旧墓碑、不让副作用
 * 在没有「失败后可记录位置」的情况下执行），对账（release/confirm）后恢复。
 */
/** 工具结果中「确定未提交」的证据码（failed_safe）。 */
export const NOT_COMMITTED_CODE = 'IDEMPOTENCY_NOT_COMMITTED';
/** 抛错是否携带「确定未提交」证据码（与结果形态 error.info.code 同构）。 */
function hasNotCommittedEvidence(error) {
    if (error === null || typeof error !== 'object')
        return false;
    const info = error.info;
    return info !== null && typeof info === 'object' && info.code === NOT_COMMITTED_CODE;
}
/** waiter 被自身 signal 中止时抛出的错误（join 脱离）。 */
export class JoinerAbortedError extends Error {
    constructor() {
        super('idempotency join aborted by caller signal');
        this.name = 'JoinerAbortedError';
    }
}
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
    maxUnknown;
    now;
    nextOwner = 1;
    constructor(maxEntries, maxInFlight = 256, maxUnknown = 1024, now = Date.now) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxEntries ${maxEntries} — must be an integer >= 1`);
        }
        if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxInFlight ${maxInFlight} — must be an integer >= 1`);
        }
        if (!Number.isInteger(maxUnknown) || maxUnknown < 1) {
            throw new Error(`dsh-tool-idempotency: invalid maxUnknown ${maxUnknown} — must be an integer >= 1`);
        }
        this.maxEntries = maxEntries;
        this.maxInFlight = maxInFlight;
        this.maxUnknown = maxUnknown;
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
        // 墓碑预算（**并发预留口径**）：现有 unknown + 在途执行（可能全部失败进 unknown）
        // 合计 ≤ maxUnknown。仅在「当前墓碑数」上检查会让多个并发的不同 key 都通过检查、
        // 各自执行副作用，完成时集体失败而突破预算。executing 全部按「可能进 unknown」
        // 预留计数，成功结算即释放预留（succeeded 不占墓碑预算）。
        if (this.unknown.size + this.executing.size >= this.maxUnknown)
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
            waiters: new Set(),
        });
        return { owner, promise };
    }
    /**
     * Join an in-flight execution（abort-aware、可脱离）：
     * - waiter 以集合形式挂在执行条目上，abort 时移除自身 + 移除监听器 → 不在 owner
     *   promise 上累积 .then 处理器（长期未完成 owner 反复 join/cancel 不累积引用）；
     * - owner 结算（settle/fail）时对全部 waiter 批量结算；
     * - 自身 signal 已中止/缺失 → 立即以 JoinerAbortedError 拒绝（不注册）。
     */
    join(key, signal) {
        const live = this.executing.get(key);
        if (live === undefined) {
            return Promise.reject(new Error(`dsh-tool-idempotency: no in-flight execution to join for key ${JSON.stringify(key)}`));
        }
        if (signal === undefined || signal.aborted) {
            return Promise.reject(new JoinerAbortedError());
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                signal,
                onAbort: () => {
                    live.waiters.delete(waiter);
                    signal.removeEventListener('abort', waiter.onAbort);
                    reject(new JoinerAbortedError());
                },
                resolve,
                reject,
            };
            live.waiters.add(waiter);
            signal.addEventListener('abort', waiter.onAbort, { once: true });
        });
    }
    /** 批量结算执行条目的全部 waiter（移除监听器、清空集合）。 */
    drainWaiters(live, outcome) {
        for (const waiter of live.waiters) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            if (outcome.kind === 'resolve')
                waiter.resolve(outcome.result);
            else
                waiter.reject(outcome.error);
        }
        live.waiters.clear();
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
        this.drainWaiters(live, { kind: 'resolve', result });
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
        // 代次条目只在「可能还有陈旧 owner 未结算」时需要；本执行已 take（同 key 不可能
        // 再有并发执行），代次检查已用毕 → 删除，避免 generations 随 key 数无限增长。
        this.generations.delete(key);
    }
    /** Thrown failure → unknown 墓碑（无提交证据），代次不匹配则不写。
     *  抛错携带 NOT_COMMITTED 证据码时视为 failed_safe（确定未提交，不留记录）。 */
    fail(key, owner, error) {
        const live = this.take(key, owner);
        if (live === undefined)
            return;
        live.reject(error);
        this.drainWaiters(live, { kind: 'reject', error });
        if (hasNotCommittedEvidence(error))
            return; // failed_safe：有证据确定未提交
        if (live.generation !== this.generationOf(key))
            return;
        this.writeUnknown(key, live.fingerprint);
        this.generations.delete(key);
    }
    /** 仅清除 succeeded 缓存 + 递增代次（补偿流程用；unknown 由 release/confirm 处理）。 */
    invalidate(key) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.cache.delete(key);
        // 无在途执行时没有「陈旧 owner 晚到」风险，代次条目立即释放（防 generations 无限增长）
        if (!this.executing.has(key))
            this.generations.delete(key);
    }
    /** 状态解除：递增代次并清除 succeeded 与 unknown（下游对账后，后续同 key 重新执行）。 */
    release(key) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.cache.delete(key);
        this.unknown.delete(key);
        if (!this.executing.has(key))
            this.generations.delete(key);
    }
    /** 下游确认已提交：写入验证过的 succeeded 结果（可重放），并递增代次防旧写回。 */
    confirm(key, fingerprint, result, ttlMs) {
        this.generations.set(key, this.generationOf(key) + 1);
        this.unknown.delete(key);
        this.cacheResult(key, 0, fingerprint, result, ttlMs);
        if (!this.executing.has(key))
            this.generations.delete(key);
    }
    /** Drop a cached succeeded result (inFlightOnly forced re-execution). */
    delete(key) {
        this.cache.delete(key);
    }
    /** Total live records (executing locks + cache + unknown). */
    get size() {
        return this.executing.size + this.cache.size + this.unknown.size;
    }
    /** unknown 墓碑预算是否耗尽（与 reserve 同口径：unknown + 在途预留 ≤ maxUnknown）。 */
    get unknownFull() {
        return this.unknown.size + this.executing.size >= this.maxUnknown;
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
    /**
     * Write an unknown tombstone. **Never evicted**: the tombstone is the only
     * thing preventing a blind re-execution after an ambiguous failure — evicting
     * it would silently re-open the duplicate-side-effect window (0.2.0 contract:
     * 对账 release/confirm 是唯一解除路径；操作方需对长期不决的 key 对账）。
     */
    writeUnknown(key, fingerprint) {
        this.unknown.set(key, {
            state: 'unknown',
            owner: 0,
            fingerprint,
            createdAt: this.now(),
            generation: this.generationOf(key),
        });
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
