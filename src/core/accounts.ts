// Turns `orca account list --json` (its `result`) into seats with usage. Orca already polls usage
// for every managed account, so the plugin never touches tokens or keychains itself.
import { liveKeyOfHome } from './live-usage.ts'
import type { Provider, Seat, SeatUsage, UsageWindow } from './types.ts'

type Json = Record<string, any>

function win(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Json
  if (typeof v.usedPercent !== 'number') return undefined
  return { usedPercent: v.usedPercent, resetsAt: typeof v.resetsAt === 'number' ? v.resetsAt : null }
}

function usageFrom(rl: unknown, row?: Json, expectedAccountId?: string): SeatUsage {
  if (!rl || typeof rl !== 'object') return { known: false, source: 'unknown', reason: 'not-reported' }
  const r = rl as Json
  const readingId = typeof r.usageMetadata?.readingAccount?.accountId === 'string' ? r.usageMetadata.readingAccount.accountId : undefined
  if (expectedAccountId && readingId && readingId !== expectedAccountId) {
    // Orca's active slot still carries the previous account's numbers right after a switch.
    return { known: false, source: 'unknown', reason: 'fetching' }
  }
  const session = win(r.session)
  const weekly = win(r.weekly)
  const ordinaryAllowed = typeof r.ordinaryUsageAllowed === 'boolean' ? r.ordinaryUsageAllowed : undefined
  const limitType = typeof r.rateLimitReachedType === 'string' && r.rateLimitReachedType.trim() ? r.rateLimitReachedType.trim() : undefined
  const known = r.status === 'ok' && (!!(session || weekly) || ordinaryAllowed === false)
  const usage: SeatUsage = { known, source: known ? 'live' : 'unknown' }
  if (session) usage.session = session
  if (weekly) usage.weekly = weekly
  if (ordinaryAllowed !== undefined) usage.ordinaryUsageAllowed = ordinaryAllowed
  if (limitType) usage.rateLimitReachedType = limitType
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
    const errText = typeof r.error === 'string' ? r.error : ''
    const looksAuth = /not signed in|authentication required|re-authenticate|token.*expired|invalid.*key|unauthenticated/i.test(errText)
    usage.reason =
      row?.isFetching || r.status === 'fetching'
        ? 'fetching'
        : kind === 'stale-token'
          ? 'stale-token'
          : kind === 'rate-limited'
            ? 'rate-limited'
            : kind === 'missing-credentials' || looksAuth
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
  const row = list.find((r: Json) => r && typeof r === 'object' && r.accountId === accountId)
  return row ? usageFrom(row.rateLimits, row) : { known: false, source: 'unknown', reason: 'not-reported' }
}

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : undefined)
/** A name to show, when it is one: text, not empty. */
const name = (s: unknown) => (typeof s === 'string' && s.trim() ? s : undefined)
/** A block of the answer, when it is one (`{}` otherwise, which lists no accounts). */
const block_ = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
/** The accounts of a block that can be named and selected: rows with an id. Anything else (a
 *  broken row) is left out rather than become an account nobody can switch to. */
const rows = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && a.id !== '') : [])
const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export type AccountView = {
  seats: Seat[]
  /** Active seat key per provider. */
  active: Partial<Record<Provider, string>>
}

export function parseAccounts(result: Json): AccountView {
  // An answer that names no service at all (empty, or not what `orca account list` gives) is no
  // answer: it must not pass for "there are no accounts", which would forget every account's
  // history and leave waiting sessions with nowhere to go. The caller keeps what it last read.
  const answered = !!result && typeof result === 'object' && !Array.isArray(result) && (['claude', 'codex', 'antigravity', 'opencode', 'devin'] as const).some((p) => result[p] && typeof result[p] === 'object')
  if (!answered) throw new Error('the answer lists no service')
  const seats: Seat[] = []
  const active: Partial<Record<Provider, string>> = {}
  const rl: Json = block_(result.rateLimits)

  // Claude and Codex: managed accounts plus the provider's own (system) login.
  for (const provider of ['claude', 'codex'] as const) {
    const block: Json = block_(result[provider])
    const accounts: Json[] = rows(block.accounts)
    const activeId: string | null = idOf(block.activeAccountId)
    const inactive = provider === 'claude' ? rl.inactiveClaudeAccounts : rl.inactiveCodexAccounts
    const systemEmail = lower(provider === 'claude' ? block.systemDefaultEmail : block.systemDefault?.email)
    const hasSystem = provider === 'claude' ? !!block.systemDefaultHome : !!block.systemDefault?.hasAuth

    for (const a of accounts) {
      const isActive = activeId === a.id
      const seat: Seat = {
        key: `${provider}:${a.id}`,
        provider,
        accountId: a.id,
        label: name(a.email) ?? name(a.workspaceLabel) ?? a.id,
        active: isActive,
        usage: isActive ? usageFrom(rl[provider], undefined, a.id) : inactiveUsage(inactive, a.id)
      }
      // Claude panes report their own usage per profile (live-usage.ts). Only the profile id is
      // taken from the account's home; the path stays out of seats, snapshots and storage.
      const liveKey = provider === 'claude' ? liveKeyOfHome(a.home) : undefined
      if (liveKey) seat.liveKeys = [liveKey]
      if (provider === 'codex' && typeof a.home === 'string' && a.home.trim()) seat.codexHome = a.home.trim()
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
        usage: activeId === null ? usageFrom(rl[provider], undefined, 'system') : { known: false, source: 'unknown', reason: 'not-reported' },
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
        seat.usage = usageFrom(rl[provider], undefined, twin?.id)
        active[provider] = seat.key
      }
    }
  }

  // Antigravity: managed accounts, plus the host's own login when no managed account is selected.
  // Orca reports that login as `currentAccount` (often without an email) and polls its usage.
  {
    const block: Json = block_(result.antigravity)
    const accounts: Json[] = rows(block.accounts)
    const activeId: string | null = idOf(block.selectedAccountId) ?? idOf(block.activeAccountId)
    for (const a of accounts) {
      const isActive = activeId === a.id
      seats.push({
        key: `antigravity:${a.id}`,
        provider: 'antigravity',
        accountId: a.id,
        label: name(a.email) ?? name(a.label) ?? a.id,
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
    const block: Json = block_(result[provider])
    const accounts: Json[] = rows(block.accounts)
    if (accounts.length === 0) continue
    const activeId: string | null = idOf(block.activeAccountId)
    for (const a of accounts) {
      seats.push({
        key: `${provider}:${a.id}`,
        provider,
        accountId: a.id,
        label: name(a.label) ?? name(a.email) ?? a.id,
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
