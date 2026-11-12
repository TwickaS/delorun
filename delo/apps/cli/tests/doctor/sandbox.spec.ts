/**
 * The `sandbox` line of `delorun doctor`: the bwrap probe through fake `bwrap` programs, the AppArmor setting, and the
 * line for each outcome, failing where an escape socket directory exists and warning where none does.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appArmorRestrictsUserNamespaces, BWRAP_PROBE_TIMEOUT_MILLIS, checkSandbox, firstExisting, runBwrapProbe, type BwrapProbe } from '../../src/doctor/sandbox.ts'
import { POSIX } from './fixtures.ts'

let base: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-sandbox-')))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe.runIf(POSIX)('runBwrapProbe', { timeout: 30_000 }, () => {
  /**
   * A directory holding a fake `bwrap` program.
   * @param body - the script after its shebang.
   * @returns the directory, for the search path.
   */
  function fakeBwrap(body: string): string {
    const bin = join(base, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\n${body}`, { mode: 0o755 })
    return bin
  }

  it('runs bwrap --ro-bind / / true and reports it usable when it exits 0', async () => {
    const args = join(base, 'args')
    expect(await runBwrapProbe(fakeBwrap(`echo "$@" > '${args}'\nexit 0\n`))).toEqual({ kind: 'usable' })
    expect(readFileSync(args, 'utf8')).toBe('--ro-bind / / true\n')
  })

  it('reports a missing program when no bwrap is on the search path', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty)
    expect(await runBwrapProbe(empty)).toEqual({ kind: 'missing' })
  })

  it('reports bwrap\'s first line, without control characters, when it fails', async () => {
    const bin = fakeBwrap('printf "\\nbwrap: setting up uid map: Permission denied\\033[0m\\nmore\\n" >&2\nexit 1\n')
    expect(await runBwrapProbe(bin)).toEqual({ kind: 'failed', reason: 'bwrap: setting up uid map: Permission denied [0m' })
    expect(await runBwrapProbe(fakeBwrap('exit 3\n'))).toEqual({ kind: 'failed', reason: 'exit status 3' })
  })

  it('reports a probe that does not finish within the timeout as timed out', async () => {
    expect(await runBwrapProbe(fakeBwrap('exec /bin/sleep 5\n'), 250)).toEqual({ kind: 'timed-out' })
  })
})

describe('appArmorRestrictsUserNamespaces', () => {
  it('reads the restriction on only when the kernel setting is 1, and off when the setting does not exist', () => {
    expect(appArmorRestrictsUserNamespaces(() => '1\n')).toBe(true)
    expect(appArmorRestrictsUserNamespaces(() => '0\n')).toBe(false)
    expect(appArmorRestrictsUserNamespaces(() => { throw new Error('ENOENT') })).toBe(false)
    expect(typeof appArmorRestrictsUserNamespaces()).toBe('boolean')
  })
})

describe('firstExisting', () => {
  it('names the first directory that exists, or none', () => {
    const present = join(base, 'present')
    mkdirSync(present)
    expect(firstExisting([join(base, 'absent'), present, base])).toBe(present)
    expect(firstExisting([join(base, 'absent')])).toBeUndefined()
  })
})

describe('checkSandbox', () => {
  const ESCAPE = '/run/user/1000'
  const failed: BwrapProbe = { kind: 'failed', reason: 'bwrap: setting up uid map: Permission denied' }

  it('passes when bubblewrap creates a sandbox', () => {
    expect(checkSandbox({ probe: { kind: 'usable' }, appArmorRestricts: true, escapeDirectory: ESCAPE })).toEqual({
      name: 'sandbox', status: 'pass', message: 'bubblewrap creates sandboxes, so sandboxed commands run with your session\'s sockets hidden.',
    })
  })

  it('fails where an escape directory exists and warns where none does, naming the fix', () => {
    expect(checkSandbox({ probe: { kind: 'missing' }, appArmorRestricts: false, escapeDirectory: ESCAPE })).toEqual({
      name: 'sandbox', status: 'fail', message: 'bubblewrap (bwrap) is not installed, so every sandboxed command is refused while /run/user/1000 exists; install the bubblewrap package, then restart Delorun.',
    })
    expect(checkSandbox({ probe: { kind: 'missing' }, appArmorRestricts: false, escapeDirectory: undefined })).toEqual({
      name: 'sandbox', status: 'warn', message: 'bubblewrap (bwrap) is not installed, so sandboxed commands run under Landlock, which cannot keep them from connecting to sockets; install the bubblewrap package, then restart Delorun.',
    })
  })

  it('names Ubuntu\'s AppArmor restriction when it is on, and bwrap\'s own message otherwise', () => {
    const restricted = checkSandbox({ probe: failed, appArmorRestricts: true, escapeDirectory: ESCAPE })
    expect(restricted.status).toBe('fail')
    expect(restricted.message).toBe('bubblewrap cannot create a sandbox because AppArmor restricts user namespaces (kernel.apparmor_restrict_unprivileged_userns is 1), so every sandboxed command is refused while /run/user/1000 exists; allow bwrap with an AppArmor profile, as Troubleshooting describes, then restart Delorun.')
    const other = checkSandbox({ probe: failed, appArmorRestricts: false, escapeDirectory: undefined })
    expect(other).toEqual({
      name: 'sandbox', status: 'warn', message: 'bubblewrap cannot create a sandbox (bwrap: setting up uid map: Permission denied), so sandboxed commands run under Landlock, which cannot keep them from connecting to sockets; run bwrap --ro-bind / / true to see why, then restart Delorun.',
    })
  })

  it('warns that a probe which timed out did not finish, without naming a cause', () => {
    const result = checkSandbox({ probe: { kind: 'timed-out' }, appArmorRestricts: true, escapeDirectory: ESCAPE })
    expect(result).toEqual({ name: 'sandbox', status: 'warn', message: `bubblewrap did not finish within ${String(BWRAP_PROBE_TIMEOUT_MILLIS / 1000)} s; run delorun doctor again when the computer is less busy.` })
    expect(result.message).not.toContain('AppArmor')
  })
})
