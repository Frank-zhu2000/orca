import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardSkillsChildPipes } from './skills-child-stdio'

// Why: destroy-only unblocks a writer that dies on EPIPE. This grandchild
// swallows EPIPE and keeps the inherited pipe, which is what a shell-wrapped
// npx descendant does after the direct child exits.

const onPosix = process.platform === 'win32' ? describe.skip : describe

function isAlive(pid: number | undefined): boolean {
  if (pid == null || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessGroup(pid: number | undefined): void {
  if (pid == null || pid <= 0) {
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone, or it was never a group leader.
  }
}

function spawnHoldingGrandchild(): ChildProcess {
  const script = [
    'process.stdout.on("error", () => {})',
    'process.stderr.on("error", () => {})',
    'process.stdout.write("pid:" + process.pid + "\\n")',
    'setInterval(() => { process.stdout.write("tick\\n") }, 40)'
  ].join('; ')
  return spawn(
    '/bin/sh',
    ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function spawnOutsideGroupWriter(): ChildProcess {
  const writer = [
    'process.stdout.on("error", () => {})',
    'process.stderr.on("error", () => {})',
    'setInterval(() => { process.stdout.write("tick\\n") }, 40)'
  ].join('; ')
  const script = [
    'const {spawn} = require("node:child_process")',
    `const writer = spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {detached: true, stdio: "inherit"})`,
    'process.stdout.write("pid:" + writer.pid + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join('; ')
  return spawn(
    '/bin/sh',
    ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

async function readGrandchildPid(child: ChildProcess): Promise<number> {
  let buffer = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`grandchild pid was not printed: ${JSON.stringify(buffer)}`))
    }, 2000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const match = /pid:(\d+)/.exec(buffer)
      if (match == null) {
        return
      }
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
  })
}

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

async function withGuard(child: ChildProcess, run: () => Promise<void>): Promise<void> {
  const guard = guardSkillsChildPipes(child)
  try {
    await run()
  } finally {
    guard.stop()
    killProcessGroup(child.pid)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

onPosix('skills child stdio teardown', () => {
  it('settles close and stops a grandchild that inherited the pipe', async () => {
    const child = spawnHoldingGrandchild()
    const directKill = vi.spyOn(child, 'kill')
    let closed = false
    child.once('close', () => {
      closed = true
    })
    await withGuard(child, async () => {
      const grandchildPid = await readGrandchildPid(child)
      expect(isAlive(grandchildPid)).toBe(true)
      process.stdout.emit('error', brokenPipe())
      await vi.waitFor(
        () => {
          expect(closed).toBe(true)
          expect(isAlive(grandchildPid)).toBe(false)
          expect(isAlive(child.pid)).toBe(false)
        },
        { timeout: 1500 }
      )
      // child.kill() signals only the direct shell, which leaves this grandchild
      // writing. A fake that emits `close` from kill() hides that wait.
      expect(directKill).not.toHaveBeenCalled()
      expect(child.stdout?.destroyed).toBe(true)
      expect(child.stderr?.destroyed).toBe(true)
    })
  })

  it('closes when a detached writer still holds the pipe after the child exits', async () => {
    const child = spawnOutsideGroupWriter()
    let writerPid = 0
    let closed = false
    child.once('close', () => {
      closed = true
    })
    const guard = guardSkillsChildPipes(child)
    try {
      writerPid = await readGrandchildPid(child)
      expect(isAlive(writerPid)).toBe(true)
      process.stdout.emit('error', brokenPipe())
      await vi.waitFor(
        () => {
          expect(closed).toBe(true)
          expect(isAlive(child.pid)).toBe(false)
        },
        { timeout: 1500 }
      )
      expect(child.stdout?.destroyed).toBe(true)
      expect(child.stderr?.destroyed).toBe(true)
    } finally {
      guard.stop()
      killProcessGroup(child.pid)
      if (writerPid > 0) {
        try {
          process.kill(writerPid, 'SIGKILL')
        } catch {
          // The writer already exited.
        }
      }
    }
  })
})

describe('skills child pipe errors', () => {
  it('rethrows a process-group kill error that is not a missing group', async () => {
    const child = spawnSleeper()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new TypeError('Unknown signal: NOSUCH'), { code: 'ERR_UNKNOWN_SIGNAL' })
    })
    try {
      await withGuard(child, async () => {
        expect(() => process.stdout.emit('error', brokenPipe())).toThrow(TypeError)
      })
    } finally {
      kill.mockRestore()
      killProcessGroup(child.pid)
      child.kill()
    }
  })

  it('treats a missing process group as already stopped and still drops the pipes', async () => {
    const child = spawnSleeper()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    try {
      await withGuard(child, async () => {
        expect(() => process.stdout.emit('error', brokenPipe())).not.toThrow()
        expect(child.stdout?.destroyed).toBe(true)
        expect(child.stderr?.destroyed).toBe(true)
      })
    } finally {
      kill.mockRestore()
      killProcessGroup(child.pid)
      child.kill()
    }
  })
})
