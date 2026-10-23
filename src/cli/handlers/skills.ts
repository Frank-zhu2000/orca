import { spawn } from 'node:child_process'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getRepeatedStringFlag } from '../flags'
import { writeStdoutLine } from '../stdout-line'
import { loadCanonicalGuides, type BundledSkillGuide } from './bundled-skill-guide-table'
import { SKILL_GUIDE_GET_HANDLER } from './skill-guide-get'
import { guardSkillsChildPipes } from './skills-child-stdio'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  getSpawnArgsForWindows,
  UnsafeWindowsBatchArgumentsError,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'
import { isUsableSkillsCliAgentKey } from '../../shared/skills-cli-agent-keys'
import {
  detectSkillsCliAgentKeys,
  detectSkillsCliUpdateAgentKeys
} from '../../shared/skills-cli-agent-detection'
import {
  buildAgentFeatureSkillInstallArgs,
  SKILLS_CLI_ENV_OVERRIDES
} from '../../shared/agent-feature-install-commands'
import { readOrcaCliBuildCommit } from '../cli-version'

function resolveSelectedSkillNames(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): string[] {
  const requestedSkills = getRepeatedStringFlag(flags, 'skill')
  const selectAll = flags.get('all') === true
  if (flags.has('skill') && requestedSkills.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --skill')
  }
  if (selectAll && requestedSkills.length > 0) {
    throw new RuntimeClientError('invalid_argument', 'Use either --all or --skill, not both.')
  }
  if (!selectAll && requestedSkills.length === 0) {
    return []
  }
  if (selectAll) {
    return guides.map((guide) => guide.name)
  }
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const canonicalNames = new Set<string>()
  for (const requested of requestedSkills) {
    const guide = guideByTopic.get(requested)
    if (!guide) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown skill "${requested}". Available skills: ${availableTopics}`
      )
    }
    canonicalNames.add(guide.name)
  }
  return [...canonicalNames].sort()
}

// Why: a long clone prints a lot of progress; the failure lines are at the end.
const SKILLS_FAILURE_OUTPUT_TAIL = 64 * 1024

function skillsAddOutputReportsFailure(output: string): boolean {
  // Why: a non-zero child status is forwarded unchanged. skills@1.7.2 already
  // exits 1 on a clone failure; clack's exit hook only appends "Canceled" and
  // does not change that code. A partial install can still print
  // "Failed to install <n>" and "Done!" and exit 0. The clone lines stay so a
  // 0 status that still printed them is not reported as success. "Symlinks
  // failed" and "Failed to install find-skills" are not that count.
  return (
    output.includes('Installation failed') ||
    (output.includes('Canceled') && output.includes('Failed to clone')) ||
    /Failed to install \d+/.test(output)
  )
}

function exitCodeForSkillsChild(
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string
): number {
  const numeric = typeof code === 'number' ? code : signal ? 1 : 0
  if (numeric !== 0) {
    return numeric
  }
  return skillsAddOutputReportsFailure(output) ? 1 : 0
}

function appendSkillsChildOutput(
  tail: string,
  chunk: Buffer | string,
  sink: NodeJS.WriteStream,
  pipeClosed: boolean
): string {
  // Why: after EPIPE the sink is dead. Further writes raise again and can
  // escape as an unhandled `error` before `close` records the child status.
  if (!pipeClosed) {
    sink.write(chunk)
  }
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  const next = tail + text
  return next.length > SKILLS_FAILURE_OUTPUT_TAIL ? next.slice(-SKILLS_FAILURE_OUTPUT_TAIL) : next
}

/** PATH with the resolved npx's own directory first, so its `env node` shebang resolves. */
function runNpxSkills(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // Why: a bare PATH lookup misses nvm/fnm/volta installs, and hardcoding
    // `npx.cmd` both misses `npx.exe` shims and hides a missing npx behind
    // cmd.exe's own exit code, so the friendly error below never fires.
    const resolved = resolveCliCommand('npx')
    let spawnCmd: string
    let spawnArgs: string[]
    try {
      ;({ spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolved, args))
    } catch (error) {
      // Why: the guard rejects cmd metacharacters, and only the resolved npx
      // path can carry them here — a username like `A&B` puts them in it.
      if (!(error instanceof UnsafeWindowsBatchArgumentsError)) {
        reject(error)
        return
      }
      reject(
        new RuntimeClientError(
          'invalid_environment',
          `Cannot run npx from "${resolved}": the path contains characters cmd.exe would ` +
            `reinterpret. Install Node.js somewhere without ${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} in the path.`
        )
      )
      return
    }
    // Why: npx is an `#!/usr/bin/env node` script, so resolving it off PATH is
    // not enough — without node alongside it the child exits 127 with no
    // 'error' event and the message below never fires.
    // Why: inherit would show output, but a 0 exit that still printed
    // "Failed to install <n>" would look like success. Pipe and replay so that
    // tail can change the status. A non-zero status, including skills@1.7.2's
    // clone failure, is forwarded as-is.
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      // Why: the child must lead its own process group so a closed operator pipe
      // can signal npx's descendants, not only the direct pid. Windows tree-kills
      // with taskkill and must not detach — that opens another console.
      detached: process.platform !== 'win32',
      // Why the shared helper: it verifies the sibling node actually exists,
      // skips a bare-name fallback whose dirname is '.', and writes the key
      // Windows will really read — all of which a local join got wrong.
      env: withCliRuntimeOnPath(resolved, { ...process.env, ...SKILLS_CLI_ENV_OVERRIDES })
    })
    let outputTail = ''
    let settled = false
    const pipes = guardSkillsChildPipes(child)
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      pipes.stop()
      resolve(exitCodeForSkillsChild(code, signal, outputTail))
    }
    const track = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        outputTail = appendSkillsChildOutput(outputTail, chunk, sink, pipes.closed())
      })
    }
    track(child.stdout, process.stdout)
    track(child.stderr, process.stderr)
    // Why: a missing npx/Node on a headless host surfaces as a raw spawn ENOENT;
    // wrap it so the CLI reports an actionable message like every other failure here.
    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      pipes.stop()
      const detail = error instanceof Error ? error.message : String(error)
      reject(
        new RuntimeClientError(
          'invalid_environment',
          `Could not run npx: ${detail}. Install Node.js and ensure npx is on PATH.`
        )
      )
    })
    // Why: 'close' follows the last stdio chunk. Tests that omit streams only
    // emit 'exit', which is enough when there is nothing to capture.
    if (child.stdout || child.stderr) {
      child.once('close', (code, signal) => finish(code, signal))
    } else {
      child.once('exit', (code, signal) => finish(code, signal))
    }
  })
}

type SkillMutationVerb = 'install' | 'update'

function resolveAgentKeys(verb: SkillMutationVerb, flags: Map<string, string | boolean>): string[] {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested === 'string') {
    // Why: one comma-separated value rather than a repeatable flag — `agent` is a
    // single-value flag on other commands and the repeatable set is process-wide,
    // so making it repeatable here would change how those parse a second --agent.
    const keys = [
      ...new Set(
        requested
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    ]
    // Why: a value like "," parses to nothing. Falling through to detection would
    // be surprising, and emitting no --agent would restore the all-agents install.
    if (keys.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
    }
    const unusable = keys.find((key) => !isUsableSkillsCliAgentKey(key))
    if (unusable !== undefined) {
      // Why: the skills CLI drops a value starting with `-`, which leaves it with
      // no target and installs into every agent it knows.
      throw new RuntimeClientError(
        'invalid_argument',
        `Invalid --agent value "${unusable}". Pass agent names such as claude-code, ` +
          'codex, or universal.'
      )
    }
    return keys
  }
  if (verb === 'update') {
    return detectSkillsCliUpdateAgentKeys()
  }
  const detected = detectSkillsCliAgentKeys()
  if (detected.length > 0) {
    return detected
  }
  // Why: without --agent, `skills add -y` falls into its own zero-detected branch
  // and installs into every agent it knows (~75), creating config directories for
  // agents this host does not have. Say so instead.
  throw new RuntimeClientError(
    'invalid_environment',
    'No coding agent detected on this host, so there is no install target. Pass ' +
      '--agent <name>[,<name>...] to choose targets explicitly — --agent universal ' +
      'writes only the shared .agents/skills directory that Orca reads.'
  )
}

function buildNpxSkillsArgs(skillNames: string[], global: boolean, agents: string[]): string[] {
  const sourceCommit = readOrcaCliBuildCommit()
  if (!sourceCommit) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Could not read the commit this Orca CLI was built from, so there is no source to install skills from.'
    )
  }
  // Why: a cold package cache makes bare `npx` prompt before it will fetch
  // `skills`, which strands an unattended host just like the picker does.
  return [
    '--yes',
    ...buildAgentFeatureSkillInstallArgs(skillNames, { sourceCommit, global, yes: true, agents })
  ]
}

/** Render the exact argv a real run spawns, so --dry-run can never drift from it. */
function formatNpxCommand(args: string[]): string {
  return `npx ${args.join(' ')}`
}

function formatSkillSelectionHelp(verb: SkillMutationVerb, skillNames: string[]): string {
  return [
    `Choose one or more skills to ${verb}:`,
    ...skillNames.map((name) => `  ${name}`),
    '',
    `Usage: orca skills ${verb} --skill <name> [--skill <name> ...]`,
    `   or: orca skills ${verb} --all`
  ].join('\n')
}

function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json }) => {
    const guides = await loadCanonicalGuides()
    const skillNames = resolveSelectedSkillNames(flags, guides)

    if (skillNames.length === 0) {
      const names = guides.map((guide) => guide.name)
      writeStdoutLine(
        json
          ? JSON.stringify({ availableSkills: names }, null, 2)
          : formatSkillSelectionHelp(verb, names)
      )
      return
    }

    // Why: this runs before target resolution because the answer belongs to the
    // other machine — agents detected here would be the wrong host's, and a host
    // that detects none would hide the forwarding problem behind that error.
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it, but this shell forwards ` +
          `orca to the Orca host. Run the same orca skills ${verb} command on the machine ` +
          "you want it on, where it can detect that host's agents."
      )
    }

    const global = flags.get('local') !== true
    // Why: update is the same pinned `skills add`; `skills update` follows GitHub HEAD,
    // which runs ahead of the build this CLI judges freshness against.
    const npxArgs = buildNpxSkillsArgs(skillNames, global, resolveAgentKeys(verb, flags))
    const command = formatNpxCommand(npxArgs)
    const dryRun = flags.get('dry-run') === true

    if (dryRun) {
      writeStdoutLine(
        json
          ? JSON.stringify({ command, skills: skillNames, global, executed: false }, null, 2)
          : `${command}\n\nRerun without --dry-run to ${verb} now.`
      )
      return
    }

    if (json) {
      // Why: a real run streams npx's own stdout so progress stays visible live;
      // that stream is not JSON, so --json can't be honored here.
      throw new RuntimeClientError(
        'invalid_argument',
        `orca skills ${verb} --json only supports --dry-run. Real ${verb}s stream ` +
          "npx's own output, which isn't JSON."
      )
    }

    // Why: the child's stdout is replayed below, so this status line must go to
    // stderr — stdout is npx's own output, not this command's JSON channel.
    process.stderr.write(`Running: ${command}\n`)
    process.exitCode = await runNpxSkills(npxArgs)
  }
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills list': async ({ json }) => {
    // Why: generated registry order is not a user-facing contract, while stable
    // canonical sorting keeps agent-visible output reproducible across builds.
    const topics = (await loadCanonicalGuides()).map((guide) => ({
      name: guide.name,
      description: guide.description.replace(/\s+/g, ' ').trim()
    }))
    writeStdoutLine(
      json
        ? JSON.stringify({ topics }, null, 2)
        : topics.map((topic) => `${topic.name}: ${topic.description}`).join('\n')
    )
  },
  ...SKILL_GUIDE_GET_HANDLER,
  'skills install': createSkillMutationHandler('install'),
  'skills update': createSkillMutationHandler('update')
}
