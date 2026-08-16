# dsh-tool-idempotency

English | [中文](README.md)

> Idempotency / duplicate-execution guard for DeepSeek Harness: when an agent retries a side-effecting tool call after a timeout or error, deduplicate by idempotency key and reuse the previous result instead of executing again.

> **Status: planned (2026-08-16), work in progress (WIP).** This README finalizes the positioning and design. The first two plugins in the suite — `dsh-chaos` (fault injection) and `dsh-tool-transaction` (Saga compensation) — are already released (npm 0.1.0); this is the third.

## Problem

Duplicate side effects caused by agent timeout/retry:

```text
create_order()        ← first call: timed out
create_order()        ← agent retry: order created twice
```

- When a tool executed but its result was lost (timeout, `TOOL_RESULT_LOST`, post-execute failure), the agent reasonably interprets the result as "not executed" and retries, duplicating a write, command, or other side effect.
- The official community has acknowledged this gap: deepseek-ai/deepseek-harness Discussion #1489 (a faulty post-execute listener broke subsequent calls → agent retries → duplicate side effects).

## Positioning

Differentiated from the official `@deepseek-ai/dsh-repeat-tool-reminder` (0.0.1-rc.3):

| | dsh-repeat-tool-reminder (official) | dsh-tool-idempotency (this plugin) |
|---|---|---|
| Behavior | advisory: reminds the agent it is looping on identical calls | enforcing: deduplicates by key, reuses the previous result |
| Hook point | observation | monotonic guard after `tools/pre-execute` |
| Result reuse | no | yes (returns the previous normalized result) |
| Persistence | no | optional (in-process Map → optional store) |

Division of labor with `dsh-tool-transaction`: **deduplication first (idempotency), compensation last (transaction)**.

Reliability Suite chain:

```text
dsh-chaos injects timeout/429 → agent retries → dsh-tool-idempotency prevents duplicate side effects → still failing → dsh-tool-transaction Saga compensation
```

## Design

```text
tool/call
   ↓
idempotency key (explicit, or derived from tool + normalized args hash)
   ↓
duplicate?
├─ no  → execute (record key → normalized result)
└─ yes → reuse previous result (not executed, no side effect)
```

- Implementation point: the monotonic guard extension point after `tools/pre-execute` (same level as `dsh-chaos`); the success path records the result inside a `tools/execute` wrapper.
- Key source priority: explicit declaration > hash of tool + normalized args (only for tools that explicitly opt in, avoiding model-invisible metadata leakage).
- Only deduplicates calls that are safe to reuse; the guard is opt-in and does not change the semantics of non-opted-in tools.
- Does not promise multi-process / distributed exactly-once (can be composed with official checkpoint/persistence plugins).

## Install

(after npm 0.1.0 release)

```sh
dsh plugin --profile web add @why-daydream/dsh-tool-idempotency
```

## Usage (design draft, effective after implementation)

```yaml
idempotency:
  keys: { create_order: explicit, send_email: hash }   # key source per tool
  store: memory        # optional: memory | file (persistent)
  ttl: 3600            # optional: key TTL
```

```ts
// explicit key (service / workflow scenarios)
await ctx.idempotency.run('create_order', { orderId }, async () => createOrder())
```

## Known Limitations and Deferred Work

- **Not yet implemented**: this repository finalizes the positioning; code, tests, and release have not started.
- No distributed locks / 2PC / cross-process exactly-once: multi-instance scenarios should compose the official `dsh-session-checkpoint-policy` or transaction compensation.
- No process-crash recovery: side-effect inspection and recovery after a crash belong to `dsh-tool-transaction` / checkpoint territory (already implemented officially; that direction was dropped).
- Result reuse is only offered for deterministic, safely replayable tools; non-deterministic tools are deduplicated without caching.

## Ecosystem position (2026-08-16 scan)

- Names: 0 GitHub repositories; npm `@why-daydream/dsh-tool-idempotency` available.
- Official neighbor: `@deepseek-ai/dsh-repeat-tool-reminder` (advisory, see table above).
- Official existing: `@deepseek-ai/dsh-session-checkpoint-policy` (persistent checkpoints, recovery direction) → this plugin does not do process-level recovery.

## Links

- Repository: https://github.com/WHY-Daydream/dsh-tool-idempotency
- Suite: `dsh-chaos` (fault injection) · `dsh-tool-transaction` (Saga compensation)
- Official docs: [Tool Execution Pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline)
