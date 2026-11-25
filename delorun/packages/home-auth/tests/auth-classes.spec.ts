/**
 * `AUTH_CLASSES` (`src/auth-classes.ts`): one table, each row in exactly one class. It fails on an unlisted Remote
 * action, an unlisted plugin Fetch route, a duplicate id and a row in two classes, and it keeps the reach policy's
 * tables and the table's `face` rows equal. Each test's comment names the check whose removal makes it fail.
 */
import { describe, expect, it } from 'vitest'
import { AUTH_CLASSES, authClassOf, checkAuthTable, stalePassEntries, type AuthRow } from '../src/auth-classes.ts'
import { REACH_ALLOWED_ACTIONS, REACH_DANGEROUS_ACTIONS, REACH_DENIED_ACTIONS, REACH_ELEVATED_ACTIONS, REACH_KEY_ACTIONS } from '../src/reach-access.ts'
import { CHANGES_ROUTE_ACCESS, PLUGIN_ROUTE_ACCESS } from '../src/route-access.ts'

const rows = (surface: AuthRow['surface']): AuthRow[] => AUTH_CLASSES.filter(row => row.surface === surface)

describe('AUTH_CLASSES', () => {
  // Removing the uniqueness check lets a row sit in two classes, so a gate could read either.
  it('has no duplicate id and no row in two classes', () => {
    expect(checkAuthTable(AUTH_CLASSES)).toEqual([])
  })

  // Proves the gate rejects: a duplicate and a doubly classed row are both reported.
  it('rejects a doubly listed row, a row in two classes and a row with no reason', () => {
    const row: AuthRow = { id: 'remote:x', surface: 'remote', authClass: 'free', reason: 'r' }
    expect(checkAuthTable([row, row])).toEqual(['remote:x is listed twice'])
    expect(checkAuthTable([row, { ...row, authClass: 'face', pass: 'admits' }])).toEqual(['remote:x is in two classes (free, face)'])
    expect(checkAuthTable([{ ...row, reason: ' ' }])).toEqual(['remote:x has no reason'])
  })

  // Removing the declaration check lets a new face row fall to a pass with no decision (A499 review P2-3).
  it('rejects a face row that declares no pass behaviour, and a pass behaviour on a row that is not face', () => {
    const row: AuthRow = { id: 'remote:x', surface: 'remote', authClass: 'face', reason: 'r' }
    expect(checkAuthTable([row])).toEqual(['remote:x is a face row that declares no pass behaviour; name it in PASS_ADMITS or PASS_ALWAYS_ASK (./pass-policy.ts)'])
    expect(checkAuthTable([{ ...row, pass: 'admits' }])).toEqual([])
    expect(checkAuthTable([{ ...row, authClass: 'free', pass: 'admits' }])).toEqual(['remote:x declares a pass behaviour but is not a face row'])
    expect(checkAuthTable([{ ...row, pass: 'alwaysAsk' }])).toEqual(['remote:x is always-ask but names no grant action'])
    expect(AUTH_CLASSES.filter(entry => entry.authClass === 'face' && entry.pass === undefined)).toEqual([])
  })

  // Removing the stale check keeps a policy entry after its row is renamed, so the renamed row declares nothing.
  it('names only face rows in the pass policy, each in one list', () => {
    expect(stalePassEntries(AUTH_CLASSES)).toEqual([])
    expect(stalePassEntries(AUTH_CLASSES.filter(entry => entry.id !== 'changes:protection-off'))).toEqual(['changes:protection-off is in the pass policy but names no face row'])
  })

  // Removing a REACH_* table's rows from the table leaves its actions unclassified.
  it('lists every Remote action of the reach tables once, in the class its table gives', () => {
    for (const action of Object.keys(REACH_ALLOWED_ACTIONS)) expect(authClassOf(`remote:${action}`), action).toBe('free')
    for (const action of Object.keys(REACH_ELEVATED_ACTIONS)) expect(authClassOf(`remote:${action}`), action).toBe('face')
    for (const action of Object.keys(REACH_DENIED_ACTIONS)) expect(authClassOf(`remote:${action}`), action).toBe('computer')
    for (const action of Object.keys(REACH_DANGEROUS_ACTIONS)) expect(authClassOf(`remote:${action}`), action).toBe('computer')
    for (const action of Object.keys(REACH_KEY_ACTIONS)) {
      expect(authClassOf(`remote:${action}`), action).toBe(action === 'credentials/set' || action === 'credentials/unset' ? 'face' : 'free')
    }
  })

  // The Ext. 4 item 4 gates are rows too: removing one leaves the call unclassified.
  it('classifies the calls the condition decides by their arguments as face', () => {
    for (const id of [
      'remote:session/create outside the known workspaces', 'remote:workspaceFiles/* outside the workspace',
      'remote:commands/execute of an unlisted command', 'remote:settings write that loosens the default preset',
    ]) expect(authClassOf(id), id).toBe('face')
  })

  // A plugin route missing from the table would be admitted by whatever its own admitPeer says.
  it('lists every plugin Fetch route and Changes route of route-access.ts', () => {
    for (const [file, routes] of Object.entries(PLUGIN_ROUTE_ACCESS)) {
      for (const [expression] of Object.entries(routes)) {
        const named = rows('route').filter(row => row.id.startsWith(`route:${file}#${expression}`))
        expect(named.length, `${file}#${expression}`).toBeGreaterThan(0)
      }
    }
    for (const key of Object.keys(CHANGES_ROUTE_ACCESS)) expect(rows('changes').some(row => row.id.startsWith(`changes:${key}`)), key).toBe(true)
  })

  // Terminal and picker rows name the hold feature their grant may open; removing it leaves a terminal needing a Face ID per keystroke.
  // F29: a terminal's metadata reads are free, so a first terminal asks for Face ID once, at create.
  it('classes a terminal\'s size limits, shells and list free, and its streams and create face (F29, F31)', () => {
    for (const id of ['remote:terminal/environment', 'remote:terminal/shells', 'remote:terminal/list']) expect(authClassOf(id), id).toBe('free')
    for (const id of ['remote:terminal/retain', 'remote:terminal/attach', 'remote:terminal/create', 'remote:terminal/watch']) expect(authClassOf(id), id).toBe('face')
    // The environment read also returns the chat's working directory; its row says so (review P3-4).
    expect(AUTH_CLASSES.find(row => row.id === 'remote:terminal/environment')?.reason).toContain('working directory')
    // The list row names every field a device receives, the launch error text included (review r2 P3-5).
    const listed = AUTH_CLASSES.find(row => row.id === 'remote:terminal/list')?.reason
    for (const field of ['id', 'title', 'shell', 'working directory', 'size', 'state', 'exit code', 'launch error', 'who started', 'input', 'sandbox mode']) expect(listed, field).toContain(field)
  })
  it('names the hold feature of terminal, picker and export rows', () => {
    expect(AUTH_CLASSES.find(row => row.id === 'remote:terminal/attach')?.hold).toBe('terminal')
    expect(AUTH_CLASSES.find(row => row.id === 'remote:directoryPicker/list')?.hold).toBe('picker')
    // Pins the export hold: `/export` opens the hold its download route is admitted by.
    expect(AUTH_CLASSES.find(row => row.id === 'remote:commands/execute')?.hold).toBe('export')
    expect(AUTH_CLASSES.find(row => row.id === 'remote:settings/mutate')?.hold).toBeUndefined()
  })

  // The passkey routes: enrolment stays at the computer, the grant routes are free to ask (a failed try counts), removal is face.
  it('classifies the passkey routes', () => {
    // The ticket routes work from a device with a single-use ticket or only show a code, so a class gate must not call them computer-only.
    for (const id of ['register/options', 'register', 'add/request']) expect(authClassOf(`auth:/auth/passkey/${id}`), id).toBe('ticket')
    expect(authClassOf('auth:/auth/passkey/add/approve')).toBe('computer')
    expect(authClassOf('auth:/auth/devices/remove')).toBe('face')
    expect(authClassOf('auth:/auth/passkey/verify')).toBe('free')
    expect(authClassOf('auth:/auth/passkey/remove')).toBe('face')
  })
})
