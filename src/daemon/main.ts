// Standalone entrypoint for `oahd` (run directly via `bin/oahd` or `oah daemon run`).
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { OahDaemon } from './server.ts'
import { logPathFor, pidPathFor, resolveOahHome } from './store.ts'

async function main(): Promise<void> {
  const home = resolveOahHome()
  const pidPath = pidPathFor(home)
  const logPath = logPathFor(home)
  const foreground = process.argv.includes('--foreground') || process.argv.includes('-f')

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} [oahd] ${msg}\n`
    if (foreground) process.stderr.write(line)
    try {
      appendFileSync(logPath, line, { mode: 0o600, encoding: 'utf8' })
    } catch {
      // Ignore log write failure.
    }
  }

  const daemon = new OahDaemon({ home, log })
  await daemon.start()
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600, encoding: 'utf8' })

  const shutdown = async (sig: string) => {
    log(`received ${sig}, shutting down`)
    await daemon.stop()
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath)
    } catch {
      // Ignore.
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(`oahd: ${String((err as Error)?.message ?? err)}\n`)
  process.exit(1)
})
