import { spawnSync } from 'node:child_process'

// Narrower than ChildProcess so a test double does not need a cast. A real
// ChildProcess is assignable: tree kill only needs the pid, the two pipes, and kill().
type SkillsPipeChild = {
  pid?: number
  stdout: { destroy(): void } | null
  stderr: { destroy(): void } | null
  kill(signal?: NodeJS.Signals): boolean
}

function isBrokenPipeError(error: Error): boolean {
  return 'code' in error && error.code === 'EPIPE'
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

export type SkillsChildPipeGuard = {
  closed: () => boolean
  stop: () => void
}

// Why: npx runs the skills CLI under a shell that forwards SIGTERM only to that
// shell. child.kill() therefore leaves a grandchild on the pipe, and `close`
// never fires. The spawn is detached on POSIX so this pid leads the group.
function signalSkillsChildGroup(child: SkillsPipeChild, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid == null || pid <= 0 || process.platform === 'win32') {
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // process.kill(-pid) throws ESRCH once the group is gone. child.kill()
    // does not throw for a missing pid — it returns false — so only ESRCH is
    // ignored. EPERM and a bad signal still propagate.
    if (!isMissingProcess(error)) {
      throw error
    }
    child.kill(signal)
  }
}

function killSkillsChildTree(child: SkillsPipeChild): void {
  const pid = child.pid
  if (pid == null || pid <= 0) {
    return
  }
  if (process.platform === 'win32') {
    // child.kill() is TerminateProcess on the direct cmd.exe. taskkill /T
    // stops the tree. Detach is not used here: it would open a new console.
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    if (result.error != null) {
      child.kill()
    }
    return
  }
  signalSkillsChildGroup(child, 'SIGTERM')
}

function destroySkillsChildStdio(child: SkillsPipeChild): void {
  // A writer that left the process group still holds the pipe. Dropping the
  // read end delivers EPIPE and lets `close` fire after the direct child exits.
  child.stdout?.destroy()
  child.stderr?.destroy()
}

// Why: replaying the child makes EPIPE the parent's problem (`orca … | head`).
// Listen only until the child settles, and stop the clone that would otherwise
// keep running after the operator's pipe closes.
export function guardSkillsChildPipes(child: SkillsPipeChild): SkillsChildPipeGuard {
  let closed = false
  const onPipeError = (error: Error): void => {
    if (!isBrokenPipeError(error)) {
      throw error
    }
    if (closed) {
      return
    }
    closed = true
    killSkillsChildTree(child)
    destroySkillsChildStdio(child)
  }
  // Why: a detached POSIX child is not in the terminal's foreground group, so
  // Ctrl+C reaches only this process. Forward it, then re-raise so the CLI
  // still exits.
  const forward = (signal: NodeJS.Signals): void => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try {
      signalSkillsChildGroup(child, signal)
    } finally {
      process.kill(process.pid, signal)
    }
  }
  const onSigint = (): void => {
    forward('SIGINT')
  }
  const onSigterm = (): void => {
    forward('SIGTERM')
  }
  process.stdout.on('error', onPipeError)
  process.stderr.on('error', onPipeError)
  if (process.platform !== 'win32') {
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
  }
  return {
    closed: () => closed,
    stop(): void {
      process.stdout.off('error', onPipeError)
      process.stderr.off('error', onPipeError)
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
  }
}
