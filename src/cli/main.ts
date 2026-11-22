// Executable entrypoint for the `oah` CLI.
import { OahClient } from './client.ts'
import { runCli } from './commands.ts'
import { runSession } from './session.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const client = new OahClient()
  if (args[0] === 'session') {
    await runSession(client)
    process.exit(0)
  }
  const out = await runCli(args, client)
  if (out.stdout) process.stdout.write(out.stdout)
  if (out.stderr) process.stderr.write(out.stderr)
  process.exit(out.code)
}

main().catch((err) => {
  process.stderr.write(`oah: ${String((err as Error)?.message ?? err)}\n`)
  process.exit(1)
})
