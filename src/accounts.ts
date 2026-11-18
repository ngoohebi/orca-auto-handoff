// Turns `orca account list --json` (its `result`) into seats with usage. Orca already polls usage
// for every managed account, so the plugin never touches tokens or keychains itself.
import { liveKeyOfHome } from './live-usage'
import type { Provider, Seat, SeatUsage, UsageWindow } from './types'

type Json = Record<string, any>

function win(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Json
  if (typeof v.usedPercent !== 'number') return undefined
  return { usedPercent: v.usedPercent, resetsAt: typeof v.resetsAt === 'number' ? v.resetsAt : null }
}

function usageFrom(rl: unknown, row?: Json): SeatUsage {
  if (!rl || typeof rl !== 'object') return { known: false, source: 'unknown', reason: 'not-reported' }
  const r = rl as Json
  const session = win(r.session)
  const weekly = win(r.weekly)
  const known = r.status === 'ok' && !!(session || weekly)
  const usage: SeatUsage = { known, source: known ? 'live' : 'unknown' }
  if (session) usage.session = session
  if (weekly) usage.weekly = weekly
  if (typeof r.updatedAt === 'number') usage.updatedAt = r.updatedAt
  // Model buckets: Claude reports e.g. `fableWeekly`, `opusWeekly`.
  for (const [k, v] of Object.entries(r)) {
    const m = k.match(/^([a-z]+)Weekly$/)
    const w = m ? win(v) : undefined
    if (m && w && (!usage.model || w.usedPercent > usage.model.usedPercent)) {
      usage.model = { ...w, name: m[1]! }
    }
  }
  if (!known) {
    // Why Orca has nothing: its own failure kind and message, never guessed.
    const kind = r.usageMetadata?.failureKind
    usage.reason =
      row?.isFetching || r.status === 'fetching'
        ? 'fetching'
        : kind === 'stale-token'
          ? 'stale-token'
          : kind === 'rate-limited'
            ? 'rate-limited'
            : kind === 'missing-credentials'
              ? 'sign-in'
              : r.status === 'error'
                ? 'error'
                : 'not-reported'
    if (typeof r.error === 'string' && r.error.trim()) usage.detail = r.error.replace(/\s+/g, ' ').trim().slice(0, 120)
    const retryAt = r.retryAtMs ?? r.usageMetadata?.retryAtMs
    if (typeof retryAt === 'number') usage.retryAt = retryAt
  }
  return usage
}

function inactiveUsage(list: unknown, accountId: string): SeatUsage {
  if (!Array.isArray(list)) return { known: false, source: 'unknown', reason: 'not-reported' }
  const row = list.find((r: Json) => r?.accountId === accountId)
  return row ? usageFrom(row.rateLimits, row) : { known: false, source: 'unknown', reason: 'not-reported' }
}

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : undefined)

export type AccountView = {
  seats: Seat[]
  /** Active seat key per provider. */
  active: Partial<Record<Provider, string>>
}

export function parseAccounts(result: Json): AccountView {
  const seats: Seat[] = []
  const active: Partial<Record<Provider, string>> = {}
  const rl: Json = result?.rateLimits ?? {}

  // Claude and Codex: managed accounts plus the provider's own (system) login.
  for (const provider of ['claude', 'codex'] as const) {
    const block: Json = result?.[provider] ?? {}
    const accounts: Json[] = Array.isArray(block.accounts) ? block.accounts : []
    const activeId: string | null = block.activeAccountId ?? null
    const inactive = provider === 'claude' ? rl.inactiveClaudeAccounts : rl.inactiveCodexAccounts
    const systemEmail = lower(provider === 'claude' ? block.systemDefaultEmail : block.systemDefault?.email)
    const hasSystem = provider === 'claude' ? !!block.systemDefaultHome : !!block.systemDefault?.hasAuth

    for (const a of accounts) {
      const isActive = activeId === a.id
      const seat: Seat = {
        key: `${provider}:${a.id}`,
        provider,
        accountId: a.id,
        label: a.email ?? a.workspaceLabel ?? a.id,
        active: isActive,
        usage: isActive ? usageFrom(rl[provider]) : inactiveUsage(inactive, a.id)
      }
      // Claude panes report their own usage per profile (live-usage.ts). Only the profile id is
      // taken from the account's home; the path stays out of seats, snapshots and storage.
      const liveKey = provider === 'claude' ? liveKeyOfHome(a.home) : undefined
      if (liveKey) seat.liveKeys = [liveKey]
      seats.push(seat)
    }
    // The system login is a seat of its own unless it is the same person as a managed account.
    const duplicate = systemEmail && accounts.some((a) => lower(a.email) === systemEmail)
    if (hasSystem && !duplicate) {
      seats.push({
        key: `${provider}:system`,
        provider,
        accountId: 'system',
        label: systemEmail ? `system (${systemEmail})` : 'system',
        active: activeId === null,
        usage: activeId === null ? usageFrom(rl[provider]) : { known: false, source: 'unknown', reason: 'not-reported' },
        ...(provider === 'claude' ? { liveKeys: ['system'] } : {})
      })
    }
    // A managed account that is the system login runs under both: its profile and Claude's own.
    if (provider === 'claude' && hasSystem && duplicate) {
      const twin = seats.find((s) => s.key === `claude:${accounts.find((a) => lower(a.email) === systemEmail)?.id}`)
      if (twin) twin.liveKeys = [...(twin.liveKeys ?? []), 'system']
    }
    if (activeId) active[provider] = `${provider}:${activeId}`
    else if (hasSystem && !duplicate) active[provider] = `${provider}:system`
    else if (hasSystem && duplicate) {
      // System is active and is a managed account's login: that seat is the active one.
      const twin = accounts.find((a) => lower(a.email) === systemEmail)
      const seat = seats.find((s) => s.key === `${provider}:${twin?.id}`)
      if (seat) {
        seat.active = true
        seat.usage = usageFrom(rl[provider])
        active[provider] = seat.key
      }
    }
  }

  // Antigravity: managed accounts, plus the host's own login when no managed account is selected.
  // Orca reports that login as `currentAccount` (often without an email) and polls its usage.
  {
    const block: Json = result?.antigravity ?? {}
    const accounts: Json[] = Array.isArray(block.accounts) ? block.accounts : []
    const activeId: string | null = block.selectedAccountId ?? block.activeAccountId ?? null
    for (const a of accounts) {
      const isActive = activeId === a.id
      seats.push({
        key: `antigravity:${a.id}`,
        provider: 'antigravity',
        accountId: a.id,
        label: a.email ?? a.label ?? a.id,
        active: isActive,
        usage: isActive ? usageFrom(rl.antigravity) : { known: false, source: 'unknown', reason: 'not-reported' }
      })
      if (isActive) active.antigravity = `antigravity:${a.id}`
    }
    const current: Json | undefined = block.currentAccount && typeof block.currentAccount === 'object' ? block.currentAccount : undefined
    const hostLogin = !!current?.authMethod || rl.antigravity?.status === 'ok'
    const currentEmail = lower(current?.email)
    const duplicate = currentEmail && accounts.some((a) => lower(a.email) === currentEmail)
    if (activeId === null && hostLogin && !duplicate) {
      seats.push({
        key: 'antigravity:system',
        provider: 'antigravity',
        accountId: 'system',
        label: currentEmail ? `system (${currentEmail})` : 'system',
        active: true,
        usage: usageFrom(rl.antigravity)
      })
      active.antigravity = 'antigravity:system'
    }
  }

  // OpenCode and Devin: profiles, no usage numbers (reactive only).
  for (const provider of ['opencode', 'devin'] as const) {
    const block: Json = result?.[provider] ?? {}
    const accounts: Json[] = Array.isArray(block.accounts) ? block.accounts : []
    if (accounts.length === 0) continue
    const activeId: string | null = block.activeAccountId ?? null
    for (const a of accounts) {
      seats.push({
        key: `${provider}:${a.id}`,
        provider,
        accountId: a.id,
        label: a.label ?? a.email ?? a.id,
        active: activeId === a.id,
        usage: { known: false, source: 'unknown', reason: 'no-usage-api' }
      })
    }
    seats.push({
      key: `${provider}:system`,
      provider,
      accountId: 'system',
      label: 'system',
      active: activeId === null,
      usage: { known: false, source: 'unknown', reason: 'no-usage-api' }
    })
    active[provider] = activeId ? `${provider}:${activeId}` : `${provider}:system`
  }

  return { seats, active }
}
