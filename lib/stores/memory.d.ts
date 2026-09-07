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
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/** 工具结果中「确定未提交」的证据码（failed_safe）。 */
export declare const NOT_COMMITTED_CODE = "IDEMPOTENCY_NOT_COMMITTED";
/** waiter 被自身 signal 中止时抛出的错误（join 脱离）。 */
export declare class JoinerAbortedError extends Error {
    constructor();
}
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
    /**
     * 「失效态」key 集合：invalidate（补偿流程）标记，release/confirm（对账解除）移除。
     * 用于区分缓存失效与对账解除——仅失效时，旧执行晚到的**失败（无提交证据）结果
     * 必须保留 unknown**（工具可能已提交副作用但响应丢失），解除时不重新上锁。
     */
    private readonly invalidatedKeys;
    private readonly maxEntries;
    private readonly maxInFlight;
    private readonly maxUnknown;
    private readonly now;
    private nextOwner;
    constructor(maxEntries: number, maxInFlight?: number, maxUnknown?: number, now?: () => number);
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
     * Join an in-flight execution（abort-aware、可脱离）：
     * - waiter 以集合形式挂在执行条目上，abort 时移除自身 + 移除监听器 → 不在 owner
     *   promise 上累积 .then 处理器（长期未完成 owner 反复 join/cancel 不累积引用）；
     * - owner 结算（settle/fail）时对全部 waiter 批量结算；
     * - 自身 signal 已中止/缺失 → 立即以 JoinerAbortedError 拒绝（不注册）。
     */
    join(key: string, signal: AbortSignal | undefined): Promise<ToolExecutionResult>;
    /** 批量结算执行条目的全部 waiter（移除监听器、清空集合）。 */
    private drainWaiters;
    /**
     * Settle an execution. Success → succeeded 缓存；带 NOT_COMMITTED 证据的错误 →
     * failed_safe（释放即可，重试允许）；其余错误 → unknown 墓碑（重试被阻止）。
     * 代次不匹配（失效/解除与旧执行并发）：
     * - invalidate 态：**禁止旧成功结果写回 ≠ 可以遗忘未知提交状态**——旧执行失败
     *   （无提交证据）必须写 unknown 阻止重试（工具可能已提交副作用但响应丢失）；
     *   旧成功结果不写回（已被失效/补偿）。
     * - release/confirm 态（真解除）：不写任何记录（旧执行晚到不得重新上锁）。
     * 所有退出路径都清理 generations/invalidatedKeys（防无界增长）。
     */
    settle(key: string, owner: number, result: ToolExecutionResult, ttlMs: number): void;
    /** Thrown failure → unknown 墓碑（无提交证据），代次不匹配时区分失效/解除态；
     *  抛错携带 NOT_COMMITTED 证据码时视为 failed_safe（确定未提交，不留记录）。
     *  所有退出路径都清理 generations/invalidatedKeys。 */
    fail(key: string, owner: number, error: unknown): void;
    /** 已有记录的 fingerprint 校验：记录存在且 fingerprint 不匹配 → 拒绝（保持原状态）。 */
    private fingerprintMatches;
    /** 仅清除 succeeded 缓存 + 递增代次 + 标记失效态（补偿流程用；unknown 由
     *  release/confirm 处理）。**校验 fingerprint**：已有记录属于不同参数（另一请求）
     *  时拒绝且保持原状态。失效态下旧执行晚到的失败必须保留 unknown（见 settle/fail）。 */
    invalidate(key: string, fingerprint?: string): boolean;
    /** 状态解除：递增代次并清除 succeeded 与 unknown，移除失效标记（下游对账后，
     *  后续同 key 重新执行；旧执行晚到不得重新上锁）。**校验 fingerprint 与可选代次**
     * （异步对账版本绑定）：已有记录属于不同参数 → 拒绝；expectedGeneration 与当前
     *  代次不一致（记录已被新一轮执行消费）→ 拒绝，避免旧对账结果作用于新一轮执行。 */
    release(key: string, fingerprint?: string, expectedGeneration?: number): boolean;
    /** 下游确认已提交：写入验证过的 succeeded 结果（可重放），并递增代次防旧写回、
     *  移除失效标记（视为对账解除）。**校验 fingerprint**：已有记录属于不同参数 →
     *  拒绝且保持原状态。 */
    confirm(key: string, fingerprint: string, result: ToolExecutionResult, ttlMs: number): boolean;
    /** Drop a cached succeeded result (inFlightOnly forced re-execution). */
    delete(key: string): void;
    /** Total live records (executing locks + cache + unknown). */
    get size(): number;
    /** unknown 墓碑预算是否耗尽（与 reserve 同口径：unknown + 在途预留 ≤ maxUnknown）。 */
    get unknownFull(): boolean;
    private generationOf;
    /** Detach the live executing row if — and only if — `owner` still owns it. */
    private take;
    /**
     * Write an unknown tombstone. **Never evicted**: the tombstone is the only
     * thing preventing a blind re-execution after an ambiguous failure — evicting
     * it would silently re-open the duplicate-side-effect window (0.2.0 contract:
     * 对账 release/confirm 是唯一解除路径；操作方需对长期不决的 key 对账）。
     */
    private writeUnknown;
    private cacheResult;
    private evictOldest;
}
