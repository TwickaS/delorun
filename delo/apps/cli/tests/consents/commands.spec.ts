/**
 * `delorun workspace full-access` and `delorun mcp` over a temporary home, a scripted home socket and a scripted prompt:
 * full access is recorded only after a yes at a terminal, a review that changed meanwhile records nothing, a folder Delo
 * never adds is refused, the running studio is asked to read the store again and a mismatch is reported; an MCP server
 * is accepted only after a yes at a terminal and with the review id that was shown, an allowed server is revoked by its
 * name only after a yes at a terminal and with the acceptance id that was shown, and every action needs Delo to run.
 */
import { randomLockId, shellQuote } from '@delo/home'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { clackConfirm } = vi.hoisted(() => ({ clackConfirm: vi.fn<() => Promise<boolean | symbol>>() }))
vi.mock('@clack/prompts', () => ({ confirm: clackConfirm, isCancel: (value: unknown) => typeof value === 'symbol' }))
import type { ResponseLine, UnsignedRequest } from '@delo/home-process'
import { permissionStorePath, readPermissionStore, serializePermissionStore } from '@delo/plugin-permission-defaults/store'
import { fullAccessNote, permissionEntriesDigest } from '@delo/plugin-permission-defaults/review'
import { workspaceKey } from '@delo/plugin-permission-defaults/workspace'
import { EXIT } from '../../src/exit.ts'
import type { CommandContext } from '../../src/command.ts'
import { createMcpCommand, type McpDependencies } from '../../src/mcp/command.ts'
import { confirmInTerminal, createWorkspaceCommand, runningProfiles, workspaceCommand, type WorkspaceDependencies } from '../../src/workspace/command.ts'

const NOW = 1_800_000_000_000
let osHome: string
let deloHome: string
let folder: string
let out: { stdout: string; stderr: string }
let context: CommandContext

beforeEach(() => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-consents-'))
  deloHome = join(osHome, '.delo')
  folder = join(osHome, 'projects', 'site')
  mkdirSync(deloHome, { recursive: true, mode: 0o700 })
  mkdirSync(folder, { recursive: true })
  out = { stdout: '', stderr: '' }
  context = {
    env: { ...process.env, HOME: osHome, DELO_HOME: deloHome, DELO_PROFILE: undefined },
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  }
})

afterEach(() => { rmSync(osHome, { recursive: true, force: true }) })

/** A scripted home socket and prompt. */
interface Scripted {
  readonly lines?: ResponseLine[][]
  readonly answers?: (boolean | undefined)[]
}

/**
 * `delorun workspace` over a scripted home socket and prompt.
 * @param overrides - the dependencies to replace, the socket's answers and the prompt's.
 * @returns the command, the requests sent and the questions asked.
 */
function workspace(overrides: Partial<WorkspaceDependencies> & Scripted = {}) {
  const sent: UnsignedRequest[] = []
  const reloaded: string[] = []
  const asked: string[] = []
  const lines = [...(overrides.lines ?? [])]
  const answers = [...(overrides.answers ?? [])]
  const command = createWorkspaceCommand({
    runningProfiles: () => [],
    send: async (_home, profile, request) => {
      sent.push(request)
      reloaded.push(profile)
      return Promise.resolve(lines.shift() ?? [])
    },
    confirm: async (message) => {
      asked.push(message)
      return Promise.resolve(answers.shift())
    },
    terminal: true,
    cwd: () => osHome,
    now: () => NOW,
    ...overrides,
  })
  return { command, sent, asked, reloaded }
}

/**
 * The grants the store holds.
 * @returns each workspace key's grant time, or null.
 */
async function grants(): Promise<Record<string, number | null>> {
  const read = await readPermissionStore(permissionStorePath(deloHome))
  return read.kind === 'readable' ? Object.fromEntries([...read.entries].map(([key, entry]) => [key, entry.fullAccessGrantedAt])) : {}
}

describe('delorun workspace full-access', () => {
  it('shows what full access means and records the grant once the person says yes at a terminal', async () => {
    const { command, asked } = workspace({ answers: [true] })
    await expect(command.run(['full-access', 'projects/site', 'on'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain(fullAccessNote(workspaceKey(folder)))
    expect(asked).toEqual(['Turn on full access for this workspace?'])
    expect(await grants()).toEqual({ [workspaceKey(folder)]: NOW })
    expect(out.stdout).toContain('Full access is on for')
  })

  it('records nothing when the person does not say yes, or cancels', async () => {
    for (const answer of [false, undefined]) {
      const { command } = workspace({ answers: [answer] })
      await expect(command.run(['full-access', folder, 'on'], context)).resolves.toBe(EXIT.failed)
    }
    expect(await grants()).toEqual({})
    expect(out.stderr).toContain('nothing was changed; full access stays off')
  })

  it('records nothing without a terminal to confirm at, and asks nothing', async () => {
    const { command, asked } = workspace({ terminal: false, answers: [true] })
    await expect(command.run(['full-access', folder, 'on'], context)).resolves.toBe(EXIT.failed)
    expect(asked).toEqual([])
    expect(await grants()).toEqual({})
    expect(out.stderr).toContain(`asks you to confirm at a terminal, so nothing was changed. Run delorun workspace full-access ${shellQuote(workspaceKey(folder))} on in a terminal`)
  })

  it('records nothing when the workspace\'s full access changed while the person answered', async () => {
    const { command } = workspace({
      confirm: async () => {
        mkdirSync(join(permissionStorePath(deloHome), '..'), { recursive: true, mode: 0o700 })
        writeFileSync(permissionStorePath(deloHome), serializePermissionStore(new Map([[workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: 1 }]])), { mode: 0o600 })
        return Promise.resolve(true)
      },
    })
    await expect(command.run(['full-access', folder, 'on'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain(`changed while you answered, so nothing was changed. Run delorun workspace full-access ${shellQuote(workspaceKey(folder))} on again`)
    expect(await grants()).toEqual({ [workspaceKey(folder)]: 1 })
  })

  it('refuses a folder Delo never adds as a workspace, and a path that is no folder', async () => {
    for (const refused of [osHome, deloHome, join(osHome, 'missing')]) {
      const { command } = workspace({ answers: [true] })
      await expect(command.run(['full-access', refused, 'on'], context)).rejects.toMatchObject({ exit: EXIT.failed })
    }
    expect(await grants()).toEqual({})
  })

  it('turns full access off without asking, and says when it is already off', async () => {
    mkdirSync(join(permissionStorePath(deloHome), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(deloHome), serializePermissionStore(new Map([[workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: 1 }]])), { mode: 0o600 })
    const { command, asked } = workspace()
    await expect(command.run(['full-access', folder, 'off'], context)).resolves.toBe(EXIT.ok)
    expect(asked).toEqual([])
    expect(await grants()).toEqual({ [workspaceKey(folder)]: null })
    await expect(command.run(['full-access', folder, 'off'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Full access is already off')
  })

  it('asks the studio of every running profile to read the store again, and names each that did not', async () => {
    const written = permissionEntriesDigest(new Map([[workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: NOW }]]))
    const matching = workspace({ runningProfiles: () => ['cli', 'work'], answers: [true], lines: [[{ ok: true, digest: written }], [{ ok: true, digest: written }]] })
    await expect(matching.command.run(['full-access', folder, 'on'], context)).resolves.toBe(EXIT.ok)
    expect(matching.sent).toEqual([{ op: 'permission.reload' }, { op: 'permission.reload' }])
    expect(matching.reloaded).toEqual(['cli', 'work'])
    out.stdout = ''
    const off = permissionEntriesDigest(new Map([[workspaceKey(folder), { preset: 'workspace-write', fullAccessGrantedAt: null }]]))
    const mixed = workspace({
      runningProfiles: () => ['cli', 'stock', 'other', 'gone'],
      lines: [[{ ok: true, digest: off }], [{ ok: false, error: 'CONSENT_UNAVAILABLE' }], [{ ok: true, digest: 'sha256:other' }], []],
    })
    await expect(mixed.command.run(['full-access', folder, 'off'], context)).resolves.toBe(EXIT.failed)
    expect(out.stdout).toContain('The studio of profile stock does not ask for full access per workspace')
    expect(out.stdout).toContain(`Full access is off for ${workspaceKey(folder)}`)
    expect(out.stderr).toContain('the studio of profile other holds other grants than were written')
    expect(out.stderr).toContain('profile gone did not read it (NO_ANSWER)')
    expect(out.stderr).toContain('restart it with delorun stop and delorun start')
    // The change is told only after the studios answered.
    expect(out.stdout.indexOf('does not ask')).toBeLessThan(out.stdout.indexOf('Full access is off'))
  })

  it('records nothing and says so when the record cannot be written or another command holds it', async () => {
    const directory = join(permissionStorePath(deloHome), '..')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o500)
    try {
      await expect(workspace().command.run(['full-access', folder, 'off'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain('Full access is already off')
      writeFileSync(join(osHome, 'unused'), '')
      const { command } = workspace({ answers: [true] })
      await expect(command.run(['full-access', folder, 'on'], context)).rejects.toMatchObject({
        exit: EXIT.failed, message: expect.stringContaining('nothing was recorded, because Delo\'s record of full-access grants'),
      })
    } finally {
      chmodSync(directory, 0o700)
    }
    expect(await grants()).toEqual({})
  })

  it('runs over the shipped dependencies, and refuses a record it cannot read', async () => {
    mkdirSync(join(permissionStorePath(deloHome), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(deloHome), serializePermissionStore(new Map([[workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: 1 }]])), { mode: 0o600 })
    await expect(workspaceCommand.run(['full-access', folder, 'off'], context)).resolves.toBe(EXIT.ok)
    expect(await grants()).toEqual({ [workspaceKey(folder)]: null })
    chmodSync(permissionStorePath(deloHome), 0o644)
    await expect(workspaceCommand.run(['full-access'], context)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('cannot be read') })
  })

  it('names a record that turned unreadable while the person answered, and words the other outcomes', async () => {
    const { command } = workspace({
      confirm: async () => {
        mkdirSync(join(permissionStorePath(deloHome), '..'), { recursive: true, mode: 0o700 })
        writeFileSync(permissionStorePath(deloHome), '{ not json', { mode: 0o600 })
        return Promise.resolve(true)
      },
    })
    await expect(command.run(['full-access', folder, 'on'], context)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('cannot be read') })
    writeFileSync(permissionStorePath(deloHome), serializePermissionStore(new Map([
      [workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: NOW }], ['/elsewhere', { preset: 'workspace-write', fullAccessGrantedAt: null }],
    ])), { mode: 0o600 })
    const { command: again } = workspace()
    await expect(again.run(['full-access', folder, 'on'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Full access is already on')
    await expect(again.run(['full-access'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('/elsewhere  safer preset')
    await expect(again.run([], context)).rejects.toMatchObject({ exit: EXIT.usage, message: expect.stringContaining('choose an action') })
  })

  it('asks at the terminal, reading a cancel as no answer', async () => {
    clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(Symbol('cancel'))
    await expect(confirmInTerminal('Turn on?')).resolves.toBe(true)
    await expect(confirmInTerminal('Turn on?')).resolves.toBeUndefined()
  })

  it('lists the profiles whose home process runs', () => {
    expect(runningProfiles(join(osHome, 'no-home'))).toEqual([])
    for (const profile of ['work', 'cli', 'stopped']) mkdirSync(join(deloHome, 'run', profile), { recursive: true })
    writeFileSync(join(deloHome, 'run', 'file'), '')
    // This process holds the home lock of two profiles; the third has none.
    for (const profile of ['work', 'cli']) {
      writeFileSync(join(deloHome, 'run', profile, 'home.lock'), JSON.stringify({ v: 1, pid: process.pid, startId: randomLockId(), runtime: '0.0.0', startedAt: new Date(NOW).toISOString() }), { mode: 0o600 })
    }
    expect(runningProfiles(deloHome)).toEqual(['cli', 'work'])
  })

  it('lists the workspaces the store holds', async () => {
    const { command } = workspace()
    await expect(command.run(['full-access'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('No workspace has full access.')
    mkdirSync(join(permissionStorePath(deloHome), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(deloHome), serializePermissionStore(new Map([[workspaceKey(folder), { preset: 'danger-full-access', fullAccessGrantedAt: NOW }]])), { mode: 0o600 })
    await expect(command.run(['full-access'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain(`${workspaceKey(folder)}  full access since ${new Date(NOW).toISOString()}`)
  })

  it('refuses a wrong command line as a usage error', async () => {
    const { command } = workspace()
    await expect(command.run(['grant', folder], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(command.run(['full-access', folder, 'maybe'], context)).rejects.toMatchObject({ exit: EXIT.usage })
  })
})

const SERVER = {
  serverName: 'files', reviewId: 'a'.repeat(32), command: 'npx', args: ['-y', 'server-filesystem'], cwd: '',
  resolvedCommand: '/usr/local/bin/npx', resolvedCwd: '/home/person', env: [{ name: 'API_TOKEN' }], files: [] as object[],
  reason: 'the acceptance store holds no acceptance for this server', change: 'new', changedVariables: [], state: 'waiting', reviewedAt: NOW,
}

const ACCEPTED = {
  acceptanceId: 'c'.repeat(32), serverName: 'git', command: 'uvx', args: ['mcp-server-git'], cwd: '/srv/repo',
  resolvedCommand: '/opt/uv/bin/uvx.cmd', resolvedCwd: '/srv/repo', resolvedShell: '/Windows/System32/cmd.exe', env: [{ name: 'GIT_TOKEN' }, { name: 'PATH', value: '/opt/git/bin' }], files: [] as object[], acceptedAt: NOW, configured: true,
}

/** The `mcp.list` answer of a studio holding {@link SERVER} waiting and {@link ACCEPTED} allowed. */
const LISTED: ResponseLine[] = [{ ok: true, servers: [SERVER], accepted: [ACCEPTED] }]

/**
 * `delorun mcp` over a scripted home socket and prompt.
 * @param overrides - the dependencies to replace, the socket's answers and the prompt's.
 * @returns the command, the requests sent and the questions asked.
 */
function mcp(overrides: Partial<McpDependencies> & Scripted = {}) {
  const sent: UnsignedRequest[] = []
  const asked: string[] = []
  const lines = [...(overrides.lines ?? [])]
  const answers = [...(overrides.answers ?? [])]
  const command = createMcpCommand({
    running: () => true,
    send: async (_home, _profile, request) => {
      sent.push(request)
      return Promise.resolve(lines.shift() ?? [])
    },
    confirm: async (message) => {
      asked.push(message)
      return Promise.resolve(answers.shift())
    },
    terminal: true,
    ...overrides,
  })
  return { command, sent, asked }
}

describe('delorun mcp', () => {
  it('lists each pending server with its start and why it waits, without an environment value', async () => {
    const { command, sent } = mcp({ lines: [LISTED] })
    await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([{ op: 'mcp.list' }])
    expect(out.stdout).toContain('files: new server\n    command: npx\n    arguments: "-y" "server-filesystem"\n    working directory: the studio\'s own\n    runs: /usr/local/bin/npx\n    runs in: /home/person\n    environment variables (values not shown): API_TOKEN\n')
  })

  it('names the executable that runs and the directory it runs in, and refuses an entry without them', async () => {
    const moved = { ...SERVER, change: 'resolved', resolvedCommand: '/home/person/project/node_modules/.bin/npx' }
    const { command } = mcp({ answers: [false], lines: [[{ ok: true, servers: [moved], accepted: [] }]] })
    await expect(command.run(['accept', 'files'], context)).resolves.toBe(EXIT.failed)
    expect(out.stdout).toContain('files: its command or working directory now resolves to another place on this computer\n')
    expect(out.stdout).toContain('    runs: /home/person/project/node_modules/.bin/npx\n    runs in: /home/person\n')
    const { resolvedCommand: _command, ...unresolved } = SERVER
    const { files: _files, ...unpinned } = SERVER
    for (const entry of [unresolved, unpinned, { ...SERVER, resolvedCwd: 1 }, { ...SERVER, resolvedShell: 2 }, { ...SERVER, files: [{ path: 3 }] }]) {
      const unreadable = mcp({ lines: [[{ ok: true, servers: [entry], accepted: [] }]] })
      await expect(unreadable.command.run(['list'], context)).rejects.toMatchObject({ exit: EXIT.failed })
    }
  })

  it('names the files a start runs and says when one changed', async () => {
    const changed = { ...SERVER, change: 'contents', files: [{ path: '/usr/local/lib/npx-cli.js', sha256: `sha256:${'a'.repeat(64)}` }, { argument: 1, path: '/srv/server.js', sha256: `sha256:${'b'.repeat(64)}` }] }
    const { command } = mcp({ lines: [[{ ok: true, servers: [changed], accepted: [] }]] })
    await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('files: a file it runs changed since you accepted it\n')
    expect(out.stdout).toContain('    runs in: /home/person\n    files it runs: /usr/local/lib/npx-cli.js, /srv/server.js\n')
  })

  it('says in plain words what changed since the person allowed each waiting server', async () => {
    const changes = {
      command: 'its command changed', arguments: 'its arguments changed', directory: 'its working directory changed',
      environment: 'its environment variables changed', unreadable: 'the acceptance list could not be read',
      resolved: 'its command or working directory now resolves to another place on this computer',
      upgraded: 'Delorun now remembers each server separately; review it once',
      contents: 'a file it runs changed since you accepted it',
    }
    for (const [change, words] of Object.entries(changes)) {
      const { command } = mcp({ lines: [[{ ok: true, servers: [{ ...SERVER, change }], accepted: [] }]] })
      await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain(`files: ${words}\n`)
    }
    const unknown = mcp({ lines: [[{ ok: true, servers: [{ ...SERVER, change: 'renamed' }], accepted: [] }]] })
    await expect(unknown.command.run(['list'], context)).rejects.toMatchObject({ exit: EXIT.failed })
  })

  it('names the changed variables and prints only the values the studio shows', async () => {
    const changed = {
      ...SERVER, change: 'environment', changedVariables: ['API_TOKEN', 'PATH'], env: [{ name: 'API_TOKEN' }, { name: 'PATH', value: '/opt/bin' }],
    }
    const { command } = mcp({ lines: [[{ ok: true, servers: [changed], accepted: [] }]] })
    await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('files: its environment variables changed\n    changed variables: API_TOKEN, PATH\n')
    expect(out.stdout).toContain('    environment variables (values not shown): API_TOKEN, PATH="/opt/bin"\n')
  })

  it('says a server was declined or revoked and stays stopped', async () => {
    for (const [state, words] of [['declined', 'you declined it'], ['revoked', 'you revoked it']] as const) {
      const { command } = mcp({ lines: [[{ ok: true, servers: [{ ...SERVER, state }], accepted: [] }]] })
      await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain(`files: new server; ${words}; it stays stopped until its start changes`)
    }
    const unknown = mcp({ lines: [[{ ok: true, servers: [{ ...SERVER, state: 'paused' }], accepted: [] }]] })
    await expect(unknown.command.run(['list'], context)).rejects.toMatchObject({ exit: EXIT.failed })
  })

  it('lists the allowed servers with their start and when they were allowed', async () => {
    const { command } = mcp({ lines: [[{ ok: true, servers: [SERVER], accepted: [ACCEPTED, { ...ACCEPTED, serverName: 'old', configured: false }] }]] })
    await expect(command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain([
      'Allowed MCP servers:',
      'git',
      '    command: uvx',
      '    arguments: "mcp-server-git"',
      '    working directory: /srv/repo',
      '    runs: /opt/uv/bin/uvx.cmd through the command shell /Windows/System32/cmd.exe',
      '    runs in: /srv/repo',
      '    environment variables (values not shown): GIT_TOKEN, PATH="/opt/git/bin"',
      `    allowed: ${new Date(NOW).toISOString()}`,
      'old',
    ].join('\n'))
    expect(out.stdout).toContain(`    no configured server has this name now\n    allowed: ${new Date(NOW).toISOString()}\nStop one and keep it stopped with delorun mcp revoke <server>.\n`)
    const empty = mcp({ lines: [[{ ok: true, servers: [], accepted: [] }]] })
    out.stdout = ''
    await expect(empty.command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toBe('No MCP server is waiting for your answer.\n\nNo MCP server is allowed.\n')
  })

  it('accepts a server with the review id it showed, once the person says yes at a terminal', async () => {
    const { command, sent, asked } = mcp({ answers: [true], lines: [LISTED, [{ ok: true, started: 1 }]] })
    await expect(command.run(['accept', 'files'], context)).resolves.toBe(EXIT.ok)
    expect(asked).toEqual(['Accept files and start it?'])
    expect(sent).toEqual([{ op: 'mcp.list' }, { op: 'mcp.accept', args: { serverName: 'files', reviewId: SERVER.reviewId } }])
    expect(out.stdout).toContain('Accepted files; it is running.')
  })

  it('accepts nothing without a yes, or without a terminal', async () => {
    const unconfirmed = mcp({ answers: [false], lines: [LISTED] })
    await expect(unconfirmed.command.run(['accept', 'files'], context)).resolves.toBe(EXIT.failed)
    expect(unconfirmed.sent).toEqual([{ op: 'mcp.list' }])
    const headless = mcp({ terminal: false, answers: [true], lines: [LISTED] })
    await expect(headless.command.run(['accept', 'files'], context)).resolves.toBe(EXIT.failed)
    expect(headless.asked).toEqual([])
    expect(headless.sent).toEqual([{ op: 'mcp.list' }])
  })

  it('says the answer was stale when the server\'s start changed after it was shown', async () => {
    const { command } = mcp({ answers: [true], lines: [LISTED, [{ ok: false, error: 'STALE_REVIEW', detail: 'reviewed again' }]] })
    await expect(command.run(['accept', 'files'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('changed after it was shown, so nothing was recorded')
  })

  it('declines a server without asking', async () => {
    const { command, sent, asked } = mcp({ lines: [LISTED, [{ ok: true, declined: true }]] })
    await expect(command.run(['decline', 'files'], context)).resolves.toBe(EXIT.ok)
    expect(asked).toEqual([])
    expect(sent.at(-1)).toEqual({ op: 'mcp.decline', args: { serverName: 'files', reviewId: SERVER.reviewId } })
  })

  it('revokes an allowed server with the acceptance id it showed, once the person says yes at a terminal', async () => {
    const { command, sent, asked } = mcp({ answers: [true], lines: [LISTED, [{ ok: true, stopped: 1 }]] })
    await expect(command.run(['revoke', 'git'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('git stops and stays stopped until its start changes or you accept it again. Other servers stay allowed.')
    expect(asked).toEqual(['Revoke git and stop it?'])
    expect(sent).toEqual([{ op: 'mcp.list' }, { op: 'mcp.revoke', args: { acceptanceId: ACCEPTED.acceptanceId } }])
    expect(out.stdout).toContain('Revoked git; it stopped.')
  })

  it('revokes nothing without a yes, or without a terminal', async () => {
    const unconfirmed = mcp({ answers: [false], lines: [LISTED] })
    await expect(unconfirmed.command.run(['revoke', 'git'], context)).resolves.toBe(EXIT.failed)
    expect(unconfirmed.sent).toEqual([{ op: 'mcp.list' }])
    expect(out.stderr).toContain('nothing was revoked; git stays allowed')
    const headless = mcp({ terminal: false, answers: [true], lines: [LISTED] })
    await expect(headless.command.run(['revoke', 'git'], context)).resolves.toBe(EXIT.failed)
    expect(headless.asked).toEqual([])
    expect(headless.sent).toEqual([{ op: 'mcp.list' }])
  })

  it('says the revoke was stale when the server\'s acceptance changed after it was shown', async () => {
    const { command } = mcp({ answers: [true], lines: [LISTED, [{ ok: false, error: 'STALE_REVIEW', detail: 'accepted again' }]] })
    await expect(command.run(['revoke', 'git'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('the allowed server changed after it was shown, so nothing was revoked. Look at it again with delorun mcp list')
  })

  it('needs Delo to run, and a server that waits', async () => {
    await expect(mcp({ running: () => false }).command.run(['list'], context)).rejects.toMatchObject({ exit: EXIT.notRunning })
    await expect(mcp({ lines: [[{ ok: true, servers: [], accepted: [] }]] }).command.run(['accept', 'files'], context)).rejects.toMatchObject({ exit: EXIT.failed })
    await expect(mcp().command.run(['accept'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    // A revoke names the server, never the command it runs.
    await expect(mcp({ lines: [LISTED] }).command.run(['revoke', 'uvx'], context)).rejects.toMatchObject({ exit: EXIT.failed })
    await expect(mcp().command.run(['revoke'], context)).rejects.toMatchObject({ exit: EXIT.usage })
  })

  it('names the action it does not know, and an action without its server', async () => {
    await expect(mcp().command.run([], context)).rejects.toMatchObject({ exit: EXIT.usage, message: expect.stringContaining('choose an action') })
    await expect(mcp().command.run(['remove', 'files'], context)).rejects.toMatchObject({ exit: EXIT.usage, message: expect.stringContaining('"remove" is not list') })
    await expect(mcp().command.run(['list', 'files'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(mcp().command.run(['accept', 'files', 'extra'], context)).rejects.toMatchObject({ exit: EXIT.usage })
  })

  it('refuses a list it cannot read, and says what the home refused', async () => {
    const unreadable = [
      { ok: true, servers: {}, accepted: [] },
      { ok: true, servers: [1], accepted: [] },
      { ok: true, servers: [{ ...SERVER, env: [{ name: 1 }] }], accepted: [] },
      { ok: true, servers: [{ ...SERVER, env: [{ name: 'PATH', value: 2 }] }], accepted: [] },
      { ok: true, servers: [{ ...SERVER, cwd: 3 }], accepted: [] },
      { ok: true, servers: [{ ...SERVER, reason: 4 }], accepted: [] },
      { ok: true, servers: [], accepted: [{ ...ACCEPTED, acceptanceId: 5 }] },
      { ok: true, servers: [], accepted: [{ ...ACCEPTED, acceptedAt: 1.5 }] },
      { ok: true, servers: [], accepted: [{ ...ACCEPTED, cwd: undefined }] },
    ]
    for (const line of unreadable) {
      await expect(mcp({ lines: [[line]] }).command.run(['list'], context)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('cannot read') })
    }
    await expect(mcp({ lines: [[{ ok: false, error: 'CONSENT_UNAVAILABLE', detail: 'no consent' }]] }).command.run(['list'], context))
      .rejects.toMatchObject({ exit: EXIT.failed, message: 'delorun mcp: the home refused: CONSENT_UNAVAILABLE (no consent)' })
    await expect(mcp({ lines: [] }).command.run(['list'], context)).rejects.toMatchObject({ message: 'delorun mcp: the home refused: NO_ANSWER' })
  })

  it('prints none for a start without arguments or environment variables', async () => {
    const bare = { ...SERVER, args: [], env: [] }
    await expect(mcp({ lines: [[{ ok: true, servers: [bare], accepted: [] }]] }).command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('    arguments: none\n')
    expect(out.stdout).toContain('    environment variables: none\n')
  })

  it('says when an accepted server starts later, a refused answer, and a revoke of a server that was not running', async () => {
    const later = mcp({ answers: [true], lines: [LISTED, [{ ok: true, started: 0 }]] })
    await expect(later.command.run(['accept', 'files'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Accepted files; it starts the next time Delo starts.')
    const refused = mcp({ answers: [true], lines: [LISTED, [{ ok: false, error: 'CONSENT_FAILED' }]] })
    await expect(refused.command.run(['accept', 'files'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('delorun mcp: the home refused: CONSENT_FAILED\n')
    const declined = mcp({ lines: [LISTED, [{ ok: false, error: 'STALE_REVIEW' }]] })
    await expect(declined.command.run(['decline', 'files'], context)).resolves.toBe(EXIT.failed)
    const idle = mcp({ answers: [true], lines: [LISTED, [{ ok: true, stopped: 0 }]] })
    await expect(idle.command.run(['revoke', 'git'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Revoked git; it was not running.')
  })
})
