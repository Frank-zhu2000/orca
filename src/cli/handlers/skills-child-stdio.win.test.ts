import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardSkillsChildPipes } from './skills-child-stdio'

const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })))

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock
}))

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

describe('skills child tree kill on Windows', () => {
  afterEach(() => {
    spawnSyncMock.mockClear()
    vi.restoreAllMocks()
  })

  it('tree-kills through taskkill when the platform is Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const directKill = vi.fn(() => true)
    const child = Object.assign(new EventEmitter(), {
      pid: 2147483000,
      stdout,
      stderr,
      kill: directKill
    })
    const guard = guardSkillsChildPipes(child)
    try {
      process.stdout.emit('error', brokenPipe())
      expect(spawnSyncMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', '2147483000', '/T', '/F'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(directKill).not.toHaveBeenCalled()
      expect(stdout.destroyed).toBe(true)
      expect(stderr.destroyed).toBe(true)
    } finally {
      guard.stop()
    }
  })
})
