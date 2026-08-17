/**
 * Package-owned invariant companion for `@why-daydream/dsh-tool-idempotency`.
 * @module @why-daydream/dsh-tool-idempotency/invariant
 */
const PACKAGE_NAME = '@why-daydream/dsh-tool-idempotency';
/** Cordis companion plugin name. */
export const name = 'tool-idempotency-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant yet: the idempotency store's per-key state transitions
 * (`NEW → EXECUTING → SUCCEEDED/FAILED`) are the contract surface; a future
 * invariant may verify that a reused result was produced by a real execution
 * and that no SUCCEEDED entry was overwritten by a different fingerprint.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
