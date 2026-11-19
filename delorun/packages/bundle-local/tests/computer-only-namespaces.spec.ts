/**
 * The shipped profile's rows against the policy of a paired device: the settings namespace of each row that stays at
 * the computer, and of each row the plugin manager protects, is the form `@delorun/home-auth` checks. The rows are read
 * from upstream's base patch and this bundle's patch, so a renamed row or a changed id form fails here instead of
 * letting a settings write through unseen.
 *
 * Each test's comment names the check whose removal makes it fail.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { computerOnlyEntryIdsOf, COMPUTER_ONLY_ROW_MODULES, createCondition, PROTECTED_ROW_REFUSAL, protectedEntryIdsOf, reachDevicePrincipal, type ReachAccessFacts } from '@delorun/home-auth'
import { PACKAGE_DIR, REPO } from './profiles.ts'

type Patch = Record<string, unknown>
type Row = { readonly id: string; readonly name: string; readonly config?: unknown }

/**
 * The rows a patch file inserts.
 * @param file - the patch file.
 * @returns the rows.
 */
function insertedRows(file: string): Row[] {
  const patches = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema }) as Patch[]
  return patches.flatMap(patch => Array.isArray(patch['insert']) ? patch['insert'] as Row[] : [])
}

const base = insertedRows(join(REPO, 'packages/bundle/base/cordis.patch.yml'))
const ours = insertedRows(join(PACKAGE_DIR, 'cordis.patch.yml'))
const patches = yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Patch[]
const managerConfig = (patches.find(patch => patch['id'] === 'plugin-manager')?.['config'] ?? {}) as Patch
const rows: Row[] = [...base, ...ours]

/** A Loader holding the shipped rows as the Loader names them: the entry id is `include:<id>`, and the row keeps its `id` option. */
const ctx = new Context()
ctx.provide('loader', { entries: () => [
  { id: 'include:plugin-manager', options: { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: managerConfig } },
  ...rows.map(row => ({ id: `include:${row.id}`, options: { id: row.id, name: row.name, config: row.config } })),
] } as never)

describe('the shipped rows that stay at the computer', () => {
  const computerOnly = rows.filter(row => Object.hasOwn(COMPUTER_ONLY_ROW_MODULES, row.name))

  it('include the gate, reach and both sandbox rows', () => {
    // The webhook endpoint's server row belongs to the webhooks pack, which a person adds later; its row is protected
    // through the pack's own patch, not through this bundle's rows.
    const inThisBundle = Object.keys(COMPUTER_ONLY_ROW_MODULES).filter(name => !name.startsWith('@delorun/bundle-webhooks/'))
    expect(computerOnly.map(row => row.name).sort()).toEqual(inThisBundle.sort())
  })

  it('are found by the policy under their settings namespace and their entry id', () => {
    const found = computerOnlyEntryIdsOf(ctx)
    // Pins the namespace form: a row's settings namespace is its `id`, and the policy must see it.
    for (const row of computerOnly) {
      expect(found.has(row.id), row.id).toBe(true)
      expect(found.has(`include:${row.id}`), row.id).toBe(true)
    }
  })

  it('are refused a settings write by an unlocked device, in dangerous mode and with a PIN page', () => {
    for (const kind of ['code', 'page', 'dangerous'] as const) {
      const facts: ReachAccessFacts = {
        admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
        elevationOf: () => (kind === 'page' ? undefined : { id: 'e' }), pageUnlockOf: () => (kind === 'page' ? { id: 'p' } : undefined), unlockModeEnabled: () => kind === 'page',
        keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
        computerOnlySwitches: () => [], protectedEntryIds: () => protectedEntryIdsOf(ctx), computerOnlyEntryIds: () => computerOnlyEntryIdsOf(ctx),
        defaultPermission: () => undefined, dangerousMode: () => kind === 'dangerous',
      }
      const principal = reachDevicePrincipal('device-1', 'reach-tailscale-private', kind === 'page' ? 'p' : undefined)
      for (const row of computerOnly) {
        expect(createCondition(facts, principal)({ action: 'settings/update', resource: { kind: 'global' }, args: { ns: row.id, patch: {} } }), `${kind} ${row.id}`).toEqual({ kind: 'deny', reason: PROTECTED_ROW_REFUSAL })
      }
    }
  })
})

describe('the rows the plugin manager protects', () => {
  const listed = (managerConfig['protectedPlugins'] ?? []) as string[]

  it('are each a shipped row, found by the policy under their settings namespace', () => {
    const found = protectedEntryIdsOf(ctx)
    expect(listed.length).toBeGreaterThan(10)
    for (const module of listed) {
      const matching = rows.filter(row => row.name === module)
      expect(matching.length, module).toBeGreaterThan(0)
      for (const row of matching) expect(found?.has(row.id), `${module} ${row.id}`).toBe(true)
    }
  })

  it('are refused a settings write under the approval grace and allowed one under a code', () => {
    const settings = (grace: boolean): ReachAccessFacts => ({
      admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
      elevationOf: () => ({ id: 'e', ...grace ? { grace: true as const } : {} }), pageUnlockOf: () => undefined, unlockModeEnabled: () => false,
      keyRefs: () => new Set<string>(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => [], protectedEntryIds: () => protectedEntryIdsOf(ctx), computerOnlyEntryIds: () => computerOnlyEntryIdsOf(ctx),
      defaultPermission: () => undefined, dangerousMode: () => false,
    })
    const principal = reachDevicePrincipal('device-1', 'reach-tailscale-private')
    const protectedRows = rows.filter(row => listed.includes(row.name) && !Object.hasOwn(COMPUTER_ONLY_ROW_MODULES, row.name))
    expect(protectedRows.length).toBeGreaterThan(8)
    for (const row of protectedRows) {
      const call = { action: 'settings/update' as const, resource: { kind: 'global' } as const, args: { ns: row.id, patch: {} } }
      // Pins the grace exclusion: a consent or guard row's settings need a code or a PIN page.
      expect(createCondition(settings(true), principal)(call), `grace ${row.id}`).toEqual({ kind: 'deny', reason: 'elevation-required: settings/update' })
      expect(createCondition(settings(false), principal)(call).kind, `code ${row.id}`).toBe('allow')
    }
  })
})
