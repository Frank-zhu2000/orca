import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexCliCommandModule from '../shared/node-cli-command-resolution'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const { detectCommandsMock, readOrcaCliBuildCommitMock, resolveCliCommandMock, spawnMock } =
  vi.hoisted(() => ({
    detectCommandsMock: vi.fn(() => new Set<string>(['claude'])),
    readOrcaCliBuildCommitMock: vi.fn<() => string | null>(() => null),
    resolveCliCommandMock: vi.fn(() => 'npx'),
    spawnMock: vi.fn()
  }))

// Why: agent detection probes the real machine, so pin it or the exit-code
// assertion depends on what the test runner happens to have installed.
vi.mock('../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsMock
}))

// Why: override only the npx lookup so the real Windows .cmd rail still runs.
vi.mock('../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCliCommandModule>()),
  resolveCliCommand: resolveCliCommandMock
}))

// Why: the install pins to the build's commit; a test run has no compiled package boundary.
vi.mock('./cli-version', () => ({
  readOrcaCliBuildCommit: readOrcaCliBuildCommitMock
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('./bundled-skill-guides.js', () => ({
  BUNDLED_SKILL_GUIDES: [
    {
      name: 'alpha',
      description: 'Use when alpha work is needed.',
      markdown: '# Alpha\n',
      fullMarkdown: '# Alpha\n',
      aliases: []
    }
  ]
}))

vi.mock('./runtime-client', async () => {
  // Why: re-export the REAL error classes rather than redefining them. format.ts
  // narrows with `instanceof` against ./runtime/types, so a look-alike class
  // here would make every CLI error fall through to the generic `runtime_error`
  // shape — mirroring the barrel keeps the mock faithful to production.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')

  class RuntimeClient {}

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { main } from './index'

class FakeSkillsChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill(): boolean {
    return true
  }
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

describe('orca skills install exit code', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('npx')
    detectCommandsMock.mockReset()
    detectCommandsMock.mockReturnValue(new Set<string>(['claude']))
    spawnMock.mockReset()
    readOrcaCliBuildCommitMock.mockReset()
    readOrcaCliBuildCommitMock.mockReturnValue(COMMIT)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function finishChild(
    child: FakeSkillsChild,
    code: number,
    write: () => void
  ): Promise<{ stdout: string; stderr: string }> {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    // Why: production waits for `close`, which is after the last chunk. Settling
    // on `exit` would miss failure text that arrives between the two.
    child.emit('exit', code, null)
    write()
    child.emit('close', code, null)
    await resultPromise
    return { stdout: stdoutText(stdoutSpy), stderr: stdoutText(stderrSpy) }
  }

  it('forwards the skills CLI clone failure status and replays the error', async () => {
    // Why: pinned skills@1.7.2 exits 1 for this transcript. Clack appends
    // "Canceled" from its exit hook and does not change that status.
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const output = await finishChild(child, 1, () => {
      child.stdout.write(
        '■  Failed to clone repository\n' + '└  Installation failed\n' + '■  Canceled\n'
      )
      child.stderr.write('skills: clone failed\n')
    })

    expect(process.exitCode).toBe(1)
    expect(output.stdout).toContain('Installation failed')
    expect(output.stdout).toContain('Canceled')
    expect(output.stderr).toContain('skills: clone failed')
  })

  it('keeps a zero exit when the child output is not an install failure', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const output = await finishChild(child, 0, () => {
      child.stdout.write('Installed 1 skill\n')
    })

    expect(process.exitCode).toBe(0)
    expect(output.stdout).toContain('Installed 1 skill')
  })

  it('treats a zero exit as failure when Installation failed arrives before close', async () => {
    // Why: this is a backstop for a 0 status that still printed the line, not
    // the pinned CLI's clone path (that path exits 1 and is covered above).
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const output = await finishChild(child, 0, () => {
      child.stdout.write('└  Installation failed\n')
    })

    expect(process.exitCode).toBe(1)
    expect(output.stdout).toContain('Installation failed')
  })

  it('treats a zero exit as failure when the skills CLI reports Failed to install N', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const output = await finishChild(child, 0, () => {
      child.stdout.write('Failed to install 2\nDone!\n')
    })

    expect(process.exitCode).toBe(1)
    expect(output.stdout).toContain('Failed to install 2')
  })

  it('keeps a zero exit for the symlink-copy warning', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    await finishChild(child, 0, () => {
      child.stdout.write(
        'Symlinks failed for: cursor\n  Files were copied instead. On Windows, enable Developer Mode for symlink support.\n'
      )
    })

    expect(process.exitCode).toBe(0)
  })

  it('forwards a non-zero close status when the output is not an install failure', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    await finishChild(child, 2, () => {
      child.stdout.write('Installed find-skills\nDone!\n')
    })

    expect(process.exitCode).toBe(2)
  })

  it('kills the child and records its status when replaying into a closed pipe', async () => {
    const child = new FakeSkillsChild()
    let settledChild = false
    const settleIfPipesDestroyed = (): void => {
      if (settledChild || !child.stdout.destroyed || !child.stderr.destroyed) {
        return
      }
      settledChild = true
      child.emit('close', null, 'SIGTERM')
    }
    child.stdout.on('close', settleIfPipesDestroyed)
    child.stderr.on('close', settleIfPipesDestroyed)
    // kill() must not settle the child. The old fake emitted `close` here, which
    // hid a grandchild that still held the pipe.
    child.kill = () => true
    spawnMock.mockReturnValue(child)
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      process.nextTick(() => {
        process.stdout.emit('error', epipe)
      })
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    let resultPromise: Promise<void> | undefined
    try {
      resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: process.platform !== 'win32' })
      )
      child.stdout.write('cloning repository\n')
      await vi.waitFor(() => {
        expect(uncaught).toEqual([])
        expect(child.stdout.destroyed).toBe(true)
        expect(child.stderr.destroyed).toBe(true)
      })
      await resultPromise
      expect(process.exitCode).toBe(1)
    } finally {
      if (!settledChild) {
        child.emit('close', null, 'SIGTERM')
      }
      await resultPromise?.catch(() => undefined)
      process.off('uncaughtException', onUncaught)
    }
  })
})
