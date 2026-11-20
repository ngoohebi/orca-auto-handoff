// The few Node APIs the worker uses, so `tsc` passes without @types/node (no npm dependencies).
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { cwd?: string | undefined; timeout?: number; maxBuffer?: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
}
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function realpathSync(path: string): string
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, options?: { mode?: number; encoding?: 'utf8' }): void
  export function renameSync(from: string, to: string): void
  export function unlinkSync(path: string): void
  export function chmodSync(path: string, mode: number): void
  export function mkdtempSync(prefix: string): string
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function readdirSync(path: string): string[]
  export function symlinkSync(target: string, path: string): void
  export function statSync(path: string): { mode: number }
  export type FSWatcher = { close(): void; on(event: string, cb: () => void): unknown }
  export function watch(path: string, listener: () => void): FSWatcher
}
declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
}
declare const process: { env: Record<string, string | undefined>; platform: string; execPath?: string }
declare function require(id: string): any
