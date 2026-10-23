import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _setWindowsTaskkillLauncherForTests } from '@orca/process-host/windows-tree-kill'
import { guardSkillsChildPipes } from './skills-child-stdio'

class FakeTaskkill extends ChildProcess {
  override kill = vi.fn(() => true)
}

class PipeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override kill = vi.fn(() => true)
}

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

describe('skills child tree kill on Windows', () => {
  const launched: FakeTaskkill[] = []
  const launch = vi.fn((_rootPid: number) => {
    const taskkill = new FakeTaskkill()
    launched.push(taskkill)
    return taskkill
  })

  afterEach(() => {
    _setWindowsTaskkillLauncherForTests(null)
    launched.length = 0
    launch.mockReset()
    launch.mockImplementation((_rootPid: number) => {
      const taskkill = new FakeTaskkill()
      launched.push(taskkill)
      return taskkill
    })
    vi.restoreAllMocks()
  })

  function windowsChild(pid?: number): PipeChild {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    _setWindowsTaskkillLauncherForTests(launch)
    const child = new PipeChild()
    if (pid != null) {
      Object.defineProperty(child, 'pid', { value: pid })
    }
    return child
  }

  it('does not kill the root when taskkill reports the tree exited', () => {
    const child = windowsChild(2147483000)
    const guard = guardSkillsChildPipes(child)
    try {
      process.stdout.emit('error', brokenPipe())
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
      expect(launch).toHaveBeenCalledWith(2147483000)
      expect(child.kill).not.toHaveBeenCalled()
      launched[0]?.emit('close', 0)
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      guard.stop()
    }
  })

  it('destroys the pipes and kills the root when taskkill exits non-zero', () => {
    const child = windowsChild(2147483000)
    const guard = guardSkillsChildPipes(child)
    try {
      process.stdout.emit('error', brokenPipe())
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
      expect(child.kill).not.toHaveBeenCalled()
      launched[0]?.emit('close', 1)
      expect(child.kill).toHaveBeenCalledOnce()
    } finally {
      guard.stop()
    }
  })

  it('kills the root when taskkill cannot start', () => {
    const child = windowsChild(2147483000)
    const guard = guardSkillsChildPipes(child)
    try {
      process.stdout.emit('error', brokenPipe())
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
      expect(launch).toHaveBeenCalledWith(2147483000)
      expect(child.kill).not.toHaveBeenCalled()
      launched[0]?.emit(
        'error',
        Object.assign(new Error('spawn taskkill.exe ENOENT'), { code: 'ENOENT' })
      )
      expect(child.kill).toHaveBeenCalledOnce()
    } finally {
      guard.stop()
    }
  })

  it('destroys the pipes without taskkill when the child has no pid', () => {
    const child = windowsChild()
    const guard = guardSkillsChildPipes(child)
    try {
      process.stdout.emit('error', brokenPipe())
      expect(launch).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
    } finally {
      guard.stop()
    }
  })
})
