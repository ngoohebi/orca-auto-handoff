// Turns `orca account list --json` (its `result`) into seats with usage. Orca already polls usage
// for every managed account, so the plugin never touches tokens or keychains itself.
import type { Provider, Seat, SeatUsage, UsageWindow } from './types'

type Json = Record<string, any>

function win(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Json
  if (typeof v.usedPercent !== 'number') return undefined
  return { usedPercent: v.usedPercent, resetsAt: typeof v.resetsAt === 'number' ? v.resetsAt : null }
}

function usageFrom(rl: unknown): SeatUsage {
  if (!rl || typeof rl !== 'object') return { known: false }
  const r = rl as Json
  const session = win(r.session)
  const weekly = win(r.weekly)
  const usage: SeatUsage = { known: r.status === 'ok' && !!(session || weekly) }
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
  return usage
}

function inactiveUsage(list: unknown, accountId: string): SeatUsage {
  if (!Array.isArray(list)) return { known: false }
  const row = list.find((r: Json) => r?.accountId === accountId)
  return row ? usageFrom(row.rateLimits) : { known: false }
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
      seats.push({
        key: `${provider}:${a.id}`,
        provider,
        accountId: a.id,
        label: a.email ?? a.workspaceLabel ?? a.id,
        active: isActive,
        usage: isActive ? usageFrom(rl[provider]) : inactiveUsage(inactive, a.id)
      })
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
        usage: activeId === null ? usageFrom(rl[provider]) : { known: false }
      })
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

  // Antigravity: managed accounts only (no system default).
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
        usage: isActive ? usageFrom(rl.antigravity) : { known: false }
      })
      if (isActive) active.antigravity = `antigravity:${a.id}`
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
        usage: { known: false }
      })
    }
    seats.push({
      key: `${provider}:system`,
      provider,
      accountId: 'system',
      label: 'system',
      active: activeId === null,
      usage: { known: false }
    })
    active[provider] = activeId ? `${provider}:${activeId}` : `${provider}:system`
  }

  return { seats, active }
}
