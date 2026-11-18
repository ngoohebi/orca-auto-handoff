// The few Node APIs the worker uses, so `tsc` passes without @types/node (no npm dependencies).
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { cwd?: string | undefined; timeout?: number; maxBuffer?: number },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
}
declare module 'node:fs' {
  export function existsSync(path: string): boolean
}
declare const process: { env: Record<string, string | undefined>; platform: string }
