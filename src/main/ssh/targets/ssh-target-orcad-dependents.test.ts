import { describe, expect, it } from 'vitest'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../shared/constants'
import { getAllWorktreeMetaForHost } from '../../persistence/loading-store/worktree-identity-metadata'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { collectDependentStateBlockers } from './ssh-target-orcad-dependents'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'
import { orcadTargetBlockerMessage } from './ssh-target-orcad-claims'

const HOST: ExecutionHostId = 'ssh:ssh-1'

function blockersFor(overrides: Parameters<typeof emptyDependentStateStore>[0]) {
  return collectDependentStateBlockers(emptyDependentStateStore(overrides), 'ssh-1')
}

function messageFor(overrides: Parameters<typeof emptyDependentStateStore>[0]): string {
  const [blocker] = blockersFor(overrides)
  if (!blocker) {
    throw new Error('expected a blocker')
  }
  return orcadTargetBlockerMessage('ssh-1', blocker)
}

describe('client state that still references an SSH target', () => {
  it('finds nothing on an empty profile, or in an untouched session partition', () => {
    expect(blockersFor({})).toEqual([])
    expect(blockersFor({ getWorkspaceSessionHostIds: () => ['local', HOST] })).toEqual([])
  })

  it('ignores a connected host: the reconnect hint and global copies in its partition', () => {
    const connected = {
      ...getDefaultWorkspaceSession(),
      activeConnectionIdsAtShutdown: ['ssh-1'],
      activeWorktreeId: 'local-wt',
      browserUrlHistory: [
        {
          url: 'https://example.com',
          normalizedUrl: 'https://example.com',
          title: 'Example',
          lastVisitedAt: 1,
          visitCount: 1
        }
      ]
    }
    expect(
      blockersFor({
        getWorkspaceSessionHostIds: () => ['local', HOST],
        getWorkspaceSession: () => connected
      })
    ).toEqual([])
  })

  it('blocks on the host session partition and names the fields holding state', () => {
    const blockers = blockersFor({
      getWorkspaceSessionHostIds: () => ['local', HOST],
      getWorkspaceSession: (hostId) =>
        hostId === HOST
          ? {
              ...getDefaultWorkspaceSession(),
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only whether the record is empty.
              tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } as never,
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only whether the record is empty.
              sleepingAgentSessionsByPaneKey: { 'tab-1:leaf': {} } as never
            }
          : getDefaultWorkspaceSession()
    })
    expect(blockers).toEqual([
      {
        code: 'orcad_migration_dependent_state',
        category: 'client-owned-state',
        dependencies: [
          {
            kind: 'workspace-session',
            count: 2,
            names: ['tabsByWorktree', 'sleepingAgentSessionsByPaneKey']
          }
        ]
      }
    ])
  })

  it('blocks when the local session points its active workspace at the host', () => {
    expect(
      messageFor({
        getWorkspaceSession: () => ({
          ...getDefaultWorkspaceSession(),
          activeWorkspaceExecutionHostId: HOST
        })
      })
    ).toContain('workspace-session ×1 (active workspace)')
  })

  it('blocks on an automation that runs on the host, by name', () => {
    const automation = {
      name: 'Nightly build',
      executionTargetType: 'ssh',
      executionTargetId: 'ssh-1'
    }
    const elsewhere = { name: 'Other', executionTargetType: 'ssh', executionTargetId: 'ssh-2' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only name and execution target.
    const automations = [automation, elsewhere] as never
    expect(messageFor({ listAutomations: () => automations })).toContain(
      'automation ×1 (Nightly build)'
    )
  })

  it('blocks on worktree metadata recorded for the host', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads the host stamp and the worktree id.
    const meta = { 'repo-1::/srv/app': { hostId: HOST } } as never
    expect(
      messageFor({
        getAllWorktreeMetaForHost: (hostId) => (hostId === HOST ? meta : {})
      })
    ).toContain('worktree-metadata ×1 (repo-1::/srv/app)')
  })

  it('does not count an unstamped global floating terminal as dependent state of an SSH target', () => {
    const legacyRows = {
      worktreeMeta: {
        [FLOATING_TERMINAL_WORKTREE_ID]: {
          instanceId: '11111111-1111-4111-8111-111111111111',
          displayName: '',
          comment: '',
          isUnread: false,
          sortOrder: 1,
          lastActivityAt: 1,
          workspaceStatus: 'in-progress'
        },
        'onboarding-setup-terminal': {
          displayName: 'setup',
          comment: '',
          isUnread: false,
          sortOrder: 2,
          lastActivityAt: 2
        }
      },
      worktreeMetaByIdentity: {},
      worktreeIdentityAliases: {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host projection reads hostId and the locator map only.
    const state = legacyRows as unknown as Parameters<typeof getAllWorktreeMetaForHost>[0]['state']

    const projected = getAllWorktreeMetaForHost({ state }, HOST)
    expect(projected).toHaveProperty(FLOATING_TERMINAL_WORKTREE_ID)
    expect(projected).toHaveProperty('onboarding-setup-terminal')
    expect(projected[FLOATING_TERMINAL_WORKTREE_ID]?.hostId).toBeUndefined()
    expect(
      blockersFor({
        getAllWorktreeMetaForHost: (hostId) => getAllWorktreeMetaForHost({ state }, hostId)
      })
    ).toEqual([])
  })

  it('blocks on a saved terminal lease of any status', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only ptyId and state.
    const leases = [{ ptyId: 'pty-9', state: 'terminated' }] as never
    expect(messageFor({ getSshRemotePtyLeases: () => leases })).toContain(
      'terminal-lease ×1 (pty-9 (terminated))'
    )
  })

  it('caps the names it reports but keeps the full count', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only ptyId and state.
    const leases = Array.from({ length: 7 }, (_, i) => ({
      ptyId: `p${i}`,
      state: 'expired'
    })) as never
    const [blocker] = blockersFor({ getSshRemotePtyLeases: () => leases })
    expect(blocker).toMatchObject({
      dependencies: [{ kind: 'terminal-lease', count: 7, names: expect.any(Array) }]
    })
    expect(
      blocker?.code === 'orcad_migration_dependent_state' && blocker.dependencies[0]?.names
    ).toHaveLength(5)
  })

  it('refuses as unverifiable when a store cannot be read, naming the store', () => {
    const blockers = blockersFor({
      listAutomations: () => {
        throw new Error('automations unreadable')
      },
      getAllWorktreeMetaForHost: () => {
        throw new Error('meta unreadable')
      }
    })
    expect(blockers).toEqual([
      {
        code: 'orcad_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: ['automation', 'worktree-metadata']
      }
    ])
    const [blocker] = blockers
    expect(blocker && orcadTargetBlockerMessage('ssh-1', blocker)).toContain(
      'could not read its saved automation, worktree-metadata state'
    )
  })
})
