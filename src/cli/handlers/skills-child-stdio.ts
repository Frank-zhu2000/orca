import { startWindowsTreeKill } from '@orca/process-host/windows-tree-kill'

// The same handle startWindowsTreeKill tracks. Callers pass the spawned npx
// child, so this file does not import node:child_process.
type SkillsPipeChild = Parameters<typeof startWindowsTreeKill>[0]

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

function stopWindowsSkillsChild(child: SkillsPipeChild): void {
  const pid = child.pid
  if (pid == null || pid <= 0) {
    return
  }
  // Why: System32 taskkill, a deadline, and TerminateProcess on the root when
  // the verdict is unverifiable. A taskkill that runs and exits non-zero does
  // not set an error, so it must still kill the root. Pipe destroy does not
  // wait for that walk. Detach is not used on Windows: it opens a console.
  startWindowsTreeKill(child, pid, () => {
    try {
      child.kill()
    } catch {
      // The root can exit before this fallback runs.
    }
  })
}

function killSkillsChildTree(child: SkillsPipeChild): void {
  if (process.platform === 'win32') {
    stopWindowsSkillsChild(child)
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
  // Why: a detached POSIX child is not in the terminal's foreground group.
  // Ctrl+C is SIGINT, and closing the terminal or dropping SSH is SIGHUP.
  // Forward the signal, then re-raise it so the CLI still exits.
  const forward = (signal: NodeJS.Signals): void => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
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
  const onSighup = (): void => {
    forward('SIGHUP')
  }
  process.stdout.on('error', onPipeError)
  process.stderr.on('error', onPipeError)
  if (process.platform !== 'win32') {
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    process.on('SIGHUP', onSighup)
  }
  return {
    closed: () => closed,
    stop(): void {
      process.stdout.off('error', onPipeError)
      process.stderr.off('error', onPipeError)
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      process.off('SIGHUP', onSighup)
    }
  }
}
