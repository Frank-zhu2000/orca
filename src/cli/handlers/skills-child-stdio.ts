import type { ChildProcess } from 'node:child_process'

function isBrokenPipeError(error: Error): boolean {
  return 'code' in error && error.code === 'EPIPE'
}

export type SkillsChildPipeGuard = {
  closed: () => boolean
  stop: () => void
}

// Why: replaying the child makes EPIPE the parent's problem (`orca … | head`).
// Listen only until the child settles, and kill a clone that would otherwise
// keep running after the operator's pipe closes.
export function guardSkillsChildPipes(child: ChildProcess): SkillsChildPipeGuard {
  let closed = false
  const onPipeError = (error: Error): void => {
    if (!isBrokenPipeError(error)) {
      throw error
    }
    if (closed) {
      return
    }
    closed = true
    try {
      child.kill()
    } catch (killError) {
      // The pid can disappear between the failed write and this signal.
      if (!(killError instanceof Error)) {
        throw killError
      }
    }
  }
  process.stdout.on('error', onPipeError)
  process.stderr.on('error', onPipeError)
  return {
    closed: () => closed,
    stop(): void {
      process.stdout.off('error', onPipeError)
      process.stderr.off('error', onPipeError)
    }
  }
}
