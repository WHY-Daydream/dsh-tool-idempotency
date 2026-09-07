/**
 * Phase 5 · 0.2.0 专项：unknown 状态机 + Saga 缓存失效（invalidate/代次）。
 *
 * 覆盖：
 * - failed_safe：带 IDEMPOTENCY_NOT_COMMITTED 证据的错误 → 释放且不留记录，重试允许；
 * - unknown：无提交证据的错误 → 阻止自动重执行，且不随 TTL 自动解除；
 * - inFlightOnly + unknown：同样阻止；
 * - query() 状态转换（executing/succeeded/unknown）；
 * - confirm(key, result)：下游确认已提交 → 可重放；
 * - invalidate()：清除缓存 + 代次递增 → 旧 owner 晚到结算不写回（陈旧结果防回写）；
 * - Saga 补偿场景：invalid 后同 key 重试观察到新业务状态。
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { NOT_COMMITTED_CODE } from '../../src/index.js'
import { deferred, executeTool, idempotencyApi, registerTool, tick, toolHarness, until } from './harness.js'

describe('0.2.0 unknown 状态机：failed_safe（有证据未提交）', () => {
  it('带 NOT_COMMITTED 证据的错误 → 释放且不留记录，重试允许重新执行', async () => {
    let attempts = 0
    let first = true
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    // 位于 guard 下游的监听器：首次调用返回「确定未提交」证据错误，之后放行
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'create_order') return next()
      if (first) {
        first = false
        return Promise.resolve({
          isError: true,
          content: [{ type: 'text', text: 'Error: not committed' }],
          error: { message: 'not committed', info: { name: 'NotCommitted', code: NOT_COMMITTED_CODE } },
        })
      }
      return next()
    })

    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: true })
    expect(attempts).toBe(0) // 副作用未执行（确定未提交）

    // failed_safe：无墓碑，重试直接重新执行（不被 unknown 阻止）
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(attempts).toBe(1)
  })
})

describe('0.2.0 unknown 状态机：无证据错误', () => {
  it('普通抛错 → unknown：重试被阻止（STATE_UNKNOWN），且不随 TTL 自动解除', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], ttl: 1 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')

    await new Promise((resolve) => setTimeout(resolve, 1100)) // 远超 TTL：unknown 不自动过期
    const retry = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1) // TTL 到期未触发重执行（K1 修复：不延迟重复副作用）
  })

  it('inFlightOnly 模式下 unknown 同样阻止重执行（不重放也不重执行）', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'send_email', mode: 'inFlightOnly' }] })
    registerTool(ctx, 'send_email', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: `sent-${attempts}` }]
    })
    await executeTool(ctx, 'send_email', { to: 'a@x' }).catch(() => undefined)
    const retry = await executeTool(ctx, 'send_email', { to: 'a@x' })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)
  })
})

describe('0.2.0 API：query / confirm', () => {
  it('query 观察 executing → succeeded 状态转换', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const call = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('executing')
    gate.resolve([{ type: 'text', text: 'order-1' }])
    await call
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('succeeded')
    expect(attempts).toBe(1)
  })

  it('confirm(key, result)：下游确认已提交 → 后续调用重放验证过的结果', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')

    // 下游对账确认副作用确实已提交，写入验证结果（需完整物化形状：isError/content/value）
    idempotencyApi(ctx).confirm('create_order', { orderId: 'a' }, {
      isError: false,
      content: [{ type: 'text', text: 'verified-committed' }],
      value: [{ type: 'text', text: 'verified-committed' }],
    })
    const replay = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(replay).toMatchObject({ isError: false, content: [{ type: 'text', text: 'verified-committed' }] })
    expect(attempts).toBe(1) // 重放确认结果，不重新执行
  })
})

describe('0.2.0 Saga 缓存失效：invalidate + 代次', () => {
  it('invalidate 清除 succeeded 缓存：同 key 重试重新执行，观察到新业务状态', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return [{ type: 'text', text: attempts === 1 ? 'status=created' : 'status=compensated-new' }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ content: [{ type: 'text', text: 'status=created' }] })

    idempotencyApi(ctx).invalidate('create_order', { orderId: 'a' }) // 补偿流程：失效缓存
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'status=compensated-new' }] })
    expect(attempts).toBe(2) // 缓存已失效：重新执行（结合业务状态与新操作身份决策）
  })

  it('代次保护：invalidate 后旧 owner 晚到结算不写回缓存（陈旧结果防回写）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' }) // 执行中（代次 1）
    await until(() => attempts === 1)

    idempotencyApi(ctx).invalidate('create_order', { orderId: 'a' }) // 失效通知（代次 → 2）
    gate.resolve([{ type: 'text', text: 'stale-order-1' }]) // 旧 owner 随后完成
    const rOwner = await owner
    expect(rOwner).toMatchObject({ isError: false }) // owner 正常返回调用方
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })).toBeUndefined() // 未写回缓存

    const next = await executeTool(ctx, 'create_order', { orderId: 'a' }) // 新调用：fresh 执行
    expect(next).toMatchObject({ isError: false, content: [{ type: 'text', text: 'stale-order-1' }] })
    expect(attempts).toBe(2) // 未重放旧结果：重新执行（无陈旧缓存）
  })

  it('并发到达：owner 完成与失效通知先后到达，状态最终一致且无陈旧回写', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      return gate.promise
    })
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1)

    gate.resolve([{ type: 'text', text: 'order-1' }])
    await tick(10) // owner 完成结算（成功 → 写入缓存）
    idempotencyApi(ctx).invalidate('create_order', { orderId: 'a' }) // 失效通知后到
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })).toBeUndefined() // 缓存已清除
    await owner
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false }) // 重新执行
    expect(attempts).toBe(2)
  })
})

describe('0.2.0 unknown 五要点补测：确认未提交后才允许重新执行', () => {
  it('release(key) 解除 unknown：对账确认未提交后，同 key 重新执行（非阻止、非重放）', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')

    idempotencyApi(ctx).release('create_order', { orderId: 'a' }) // 下游对账：确认未提交 → 解除
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })).toBeUndefined()

    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 确认未提交后允许重新执行
  })

  it('容量淘汰豁免：maxEntries 压力下 unknown 墓碑不被淘汰（不静默解除防重复副作用标记）', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxEntries: 2 })
    registerTool(ctx, 'create_order', async () => {
      throw new Error('boom')
    })
    for (let i = 0; i < 5; i++) {
      await executeTool(ctx, 'create_order', { orderId: `k${i}` }).catch(() => undefined)
    }
    // 5 个不同 key 全部失败 → 5 个墓碑全部保留（远超市容量 maxEntries=2 也不淘汰）
    for (let i = 0; i < 5; i++) {
      const retry = await executeTool(ctx, 'create_order', { orderId: `k${i}` })
      expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    }
    // 显式 release 才是唯一解除路径：仅被解除的 key 可重新执行
    idempotencyApi(ctx).release('create_order', { orderId: 'k3' })
    await executeTool(ctx, 'create_order', { orderId: 'k3' }).catch(() => undefined)
    for (let i = 0; i < 5; i++) {
      const retry = await executeTool(ctx, 'create_order', { orderId: `k${i}` })
      expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    }
  })

  it('墓碑预算：maxUnknown 满时新 key 前置拒绝（副作用不执行），对账后恢复', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }], maxUnknown: 2 })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      throw new Error('boom')
    })
    await executeTool(ctx, 'create_order', { orderId: 'k1' }).catch(() => undefined)
    await executeTool(ctx, 'create_order', { orderId: 'k2' }).catch(() => undefined)

    // 第 3 个新 key：前置拒绝（IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED），副作用不执行
    const r3 = await executeTool(ctx, 'create_order', { orderId: 'k3' })
    expect(r3).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_UNKNOWN_CAPACITY_REJECTED' } } })
    expect(attempts).toBe(2) // k3 未执行

    // 历史 unknown 不被绕过
    const rk1 = await executeTool(ctx, 'create_order', { orderId: 'k1' })
    expect(rk1).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })

    // 对账 release 一个 → 新 key 可执行；失败后仍有位置记录 unknown
    idempotencyApi(ctx).release('create_order', { orderId: 'k1' })
    const r4 = await executeTool(ctx, 'create_order', { orderId: 'k3' })
    expect(r4).toMatchObject({ isError: true }) // 工具仍抛错 → 再次 unknown
    expect(attempts).toBe(3)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k3' })?.state).toBe('unknown')
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'k2' })?.state).toBe('unknown') // 历史墓碑仍在
  })

  it('陈旧 owner 晚到抛错不写回 unknown（release 解除后旧执行失败不重新上锁）', async () => {
    let attempts = 0
    const gate = deferred<ContentBlock[]>()
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) return gate.promise // 首次挂起
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const owner = executeTool(ctx, 'create_order', { orderId: 'a' })
    await until(() => attempts === 1)

    idempotencyApi(ctx).release('create_order', { orderId: 'a' }) // 代次 → 2
    gate.reject(new Error('late boom')) // 旧 owner 随后失败
    await owner.catch(() => undefined)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })).toBeUndefined() // 无 unknown 写回

    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 未被陈旧失败重新上锁
  })

  it('抛错携带 NOT_COMMITTED 证据（HarnessError code，宿主保留 info）→ failed_safe：无墓碑，重试允许重新执行', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new HarnessError('not committed', NOT_COMMITTED_CODE)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    // 宿主把 HarnessError 映射为 isError 结果并保留 error.info.code（证据契约的唯一真实路径）
    expect(r1).toMatchObject({ isError: true, error: { info: { code: NOT_COMMITTED_CODE } } })
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })).toBeUndefined() // failed_safe：未留墓碑

    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(attempts).toBe(2) // 有证据确定未提交 → 重试允许
  })
})

describe('0.2.0 对账决策必须核对业务账本（非仅调用 release 后工具可再运行）', () => {
  it('对账=已提交：confirm 写入验证结果，重试重放且账本不新增（无重复副作用）', async () => {
    const ledger: string[] = []
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      // 模拟：副作用已提交（账本写入），但响应在返回前丢失（抛错）
      ledger.push(`order-${attempts}`)
      throw new Error('response lost after commit')
    })
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    expect(ledger).toEqual(['order-1']) // 业务账本：已提交
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')

    // 重试：不得再次提交（账本不增）
    const retry = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(retry).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(ledger).toEqual(['order-1'])

    // 下游对账：账本显示已提交 → confirm 验证结果 → 重试重放，账本仍一条
    idempotencyApi(ctx).confirm('create_order', { orderId: 'a' }, {
      isError: false,
      content: [{ type: 'text', text: 'order-1' }],
      value: [{ type: 'text', text: 'order-1' }],
    })
    const replay = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(replay).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-1' }] })
    expect(ledger).toEqual(['order-1']) // 重放不新增
    expect(attempts).toBe(1)
  })

  it('对账=确认未提交：release 后重新执行，账本恰新增一条（无重复）', async () => {
    const ledger: string[] = []
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom before commit') // 未提交（账本为空）
      ledger.push(`order-${attempts}`)
      return [{ type: 'text', text: `order-${attempts}` }]
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    expect(ledger).toEqual([]) // 业务账本为空：确认未提交
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')

    idempotencyApi(ctx).release('create_order', { orderId: 'a' }) // 对账确认未提交 → 解除
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: false, content: [{ type: 'text', text: 'order-2' }] })
    expect(ledger).toEqual(['order-2']) // 账本恰一条新提交，无重复
    expect(attempts).toBe(2)
  })

  it('对账=仍无法确定：保持 unknown，重试持续被阻止', async () => {
    let attempts = 0
    const ctx = await toolHarness({ rules: [{ tool: 'create_order' }] })
    registerTool(ctx, 'create_order', async () => {
      attempts += 1
      throw new Error('boom')
    })
    await executeTool(ctx, 'create_order', { orderId: 'a' }).catch(() => undefined)
    // 下游无法确定 → 不 release 不 confirm
    const r1 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r1).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    const r2 = await executeTool(ctx, 'create_order', { orderId: 'a' })
    expect(r2).toMatchObject({ isError: true, error: { info: { code: 'IDEMPOTENCY_STATE_UNKNOWN' } } })
    expect(attempts).toBe(1)
    expect(idempotencyApi(ctx).query('create_order', { orderId: 'a' })?.state).toBe('unknown')
  })
})
