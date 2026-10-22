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

  it('exits non-zero and surfaces the skills CLI error when install fails but the child exits 0', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.stdout.write(
      '■  Failed to clone repository\n' + '└  Installation failed\n' + '■  Canceled\n'
    )
    child.stderr.write('skills: clone failed\n')
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await resultPromise

    expect(process.exitCode).toBe(1)
    expect(stdoutText(stdoutSpy)).toContain('Installation failed')
    expect(stdoutText(stdoutSpy)).toContain('Canceled')
    expect(stdoutText(stderrSpy)).toContain('skills: clone failed')
  })

  it('keeps a zero exit when the child output is not an install failure', async () => {
    const child = new FakeSkillsChild()
    spawnMock.mockReturnValue(child)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.stdout.write('Installed 1 skill\n')
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await resultPromise

    expect(process.exitCode).toBe(0)
    expect(stdoutText(stdoutSpy)).toContain('Installed 1 skill')
  })
})
