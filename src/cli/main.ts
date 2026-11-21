// Executable entrypoint for the `oah` CLI.
import { OahClient } from './client.ts'
import { runCli } from './commands.ts'

async function main(): Promise<void> {
  const client = new OahClient()
  const out = await runCli(process.argv.slice(2), client)
  if (out.stdout) process.stdout.write(out.stdout)
  if (out.stderr) process.stderr.write(out.stderr)
  process.exit(out.code)
}

main().catch((err) => {
  process.stderr.write(`oah: ${String((err as Error)?.message ?? err)}\n`)
  process.exit(1)
})
