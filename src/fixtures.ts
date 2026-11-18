// Terminal tails and `orca account list --json` results used by the tests.
// REAL = captured from the real CLIs (2026-11-18); the rest follow each CLI's known banner wording.

/** REAL: Codex on Ollama Cloud out of credits (orchestration review worker). */
export const CODEX_OLLAMA_CREDITS = [
  '  Deliverable: report via worker_done a review with (1) factual errors vs the Orca API',
  '■ stream disconnected before completion: Add usage credits or subscribe and save up to 66%: https://ollama.com/plans (ref: 00000000-0000-4000-8000-000000000000)',
  '',
  '› Ask Codex to do anything',
  '  gemma4:31b:cloud default · ~/projects/demo · Ask coordinator for guidance',
  '  ← for agents · ? for shortcuts'
]

/** REAL: Antigravity individual quota (orchestration review worker). */
export const AGY_QUOTA = [
  '● Explored 1 file (plan.md)',
  '● Ran 2 commands (+1 · orca account --help && orca account list --json && agy --help) (ctrl+o to expand)',
  '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 135h42m31s.',
  'Error ID: 00000000-0000-4000-8000-000000000001-5',
  '───────────────────────────────────────────────────────────────',
  '>',
  '───────────────────────────────────────────────────────────────',
  '? for shortcuts                                       auto · Gemini 4 Argon · medium'
]

export const CLAUDE_SESSION_LIMIT = [
  '⏺ I updated the parser and the tests pass.',
  '',
  '  ⎿  5-hour limit reached ∙ resets 3pm',
  '     /upgrade to increase your usage limit.',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ >                                            │',
  '╰──────────────────────────────────────────────╯'
]

export const CLAUDE_LEGACY_EPOCH = ['⏺ Working on it', 'Claude AI usage limit reached|1795000000']

export const CLAUDE_MODEL_CAP = ['⏺ Reading files', '  ⎿  Fable weekly limit reached ∙ resets Mon 9am', '     /model to switch models.']

export const CLAUDE_API_ERROR = ['⏺ Running tests', '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']

export const CLAUDE_TALKING_ABOUT_LIMITS = [
  '⏺ The adapter matches messages such as a rate limit or a quota.',
  '  It never retries on its own when the user discusses limits.',
  '  Done: 3 files changed.'
]

export const CODEX_USAGE_LIMIT = [
  '• Edited src/app.ts (+4 -1)',
  "■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 days 3 hours 4 minutes."
]

/** Shape of `orca account list --json` → result (emails replaced). */
export function accountList(options: {
  claudeActive?: string | null
  claudeUsage?: { session: number; weekly: number; sessionReset?: number; weeklyReset?: number }
  codexActive?: string | null
  codexUsage?: { session: number; weekly: number }
  inactiveCodex?: Record<string, number>
} = {}): Record<string, any> {
  const claudeUsage = options.claudeUsage ?? { session: 7, weekly: 18 }
  const codexUsage = options.codexUsage ?? { session: 0, weekly: 0 }
  return {
    claude: {
      accounts: [
        { id: 'c1', email: 'one@example.test', authMethod: 'subscription-oauth' },
        { id: 'c2', email: 'two@example.test', authMethod: 'subscription-oauth' },
        { id: 'c3', email: 'me@example.test', authMethod: 'subscription-oauth' }
      ],
      activeAccountId: options.claudeActive === undefined ? 'c1' : options.claudeActive,
      systemDefaultHome: '/home/me/.claude',
      systemDefaultEmail: 'me@example.test'
    },
    codex: {
      accounts: [
        { id: 'x1', email: 'one@example.test', workspaceLabel: 'Personal (Plus)' },
        { id: 'x2', email: 'two@example.test', workspaceLabel: 'Personal (Plus)' }
      ],
      activeAccountId: options.codexActive === undefined ? 'x1' : options.codexActive,
      systemDefault: { hasAuth: true, email: 'free@example.test', workspaceLabel: 'Personal (Free)' }
    },
    antigravity: { accounts: [], activeAccountId: null, selectedAccountId: null },
    opencode: { accounts: [], activeAccountId: null },
    devin: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: {
        provider: 'claude',
        status: 'ok',
        session: { usedPercent: claudeUsage.session, windowMinutes: 300, resetsAt: claudeUsage.sessionReset ?? 1_000_000 + 3_600_000 },
        weekly: { usedPercent: claudeUsage.weekly, windowMinutes: 10080, resetsAt: claudeUsage.weeklyReset ?? 1_000_000 + 86_400_000 },
        fableWeekly: { usedPercent: 19, windowMinutes: 10080, resetsAt: 1_000_000 + 86_400_000 },
        updatedAt: 1_000_000
      },
      codex: {
        provider: 'codex',
        status: 'ok',
        session: { usedPercent: codexUsage.session, windowMinutes: 300, resetsAt: 1_000_000 + 3_600_000 },
        weekly: { usedPercent: codexUsage.weekly, windowMinutes: 10080, resetsAt: 1_000_000 + 86_400_000 },
        updatedAt: 1_000_000
      },
      inactiveClaudeAccounts: [
        { accountId: 'c2', rateLimits: { provider: 'claude', status: 'error', session: null, weekly: null, error: 'Claude usage updates the next time Claude runs.' } }
      ],
      inactiveCodexAccounts: Object.entries(options.inactiveCodex ?? { x2: 100 }).map(([accountId, used]) => ({
        accountId,
        rateLimits: {
          provider: 'codex',
          status: 'ok',
          session: { usedPercent: used, windowMinutes: 300, resetsAt: 1_000_000 + 7_200_000 },
          weekly: null
        }
      }))
    }
  }
}
