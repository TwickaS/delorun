/**
 * Denial specs for an edit to the files of a linked plugin the person approved and turned on, with protection on: the
 * edited plugin does not load on the next reload or start until the person approves it again at the computer. This is
 * what holds a plugin the studio or a chat created in a workspace (`link:<folder>`) while the agent keeps editing it.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyChange, attestTerminal, listChanges, readChangeLog, readProtection, setProtection } from '@delorun/changes'
import { expect, it, vi } from 'vitest'
import { active, bootProfile, bundleFolder, evaluated, linkFolder, PROFILE, profileHome, start, writeModule, type ProfileHome } from './reload-fixture.ts'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Hmr from '@deepseek-ai/dsh-hmr'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { mountChanges } from './reload-fixture.ts'

vi.setConfig({ testTimeout: 90_000 })

/**
 * Boot the profile with the plugin manager, the Changes check and hot reload, as a Delorun Host runs them.
 * @param fx - the home.
 * @returns a recomposition inside hot reload's queue.
 */
async function live(fx: ProfileHome) {
  const { ctx } = await bootProfile(fx)
  await ctx.plugin(PluginManager, {})
  await mountChanges(ctx)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
  return { ctx, reconcile: () => ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile()) }
}

/**
 * The module a start or reload would evaluate. A module evaluated once in a process is not evaluated again at its path,
 * so the specs read the file that would load as well as the marker.
 * @param fx - the home.
 * @param name - a package name.
 * @returns the text of the module in the plugin's active directory.
 */
function loadable(fx: ProfileHome, name: string): string {
  return readFileSync(join(active(fx, name), 'index.mjs'), 'utf8')
}

/**
 * @param fx - the home.
 * @param name - a package name.
 * @returns the changes waiting for the person's review in the plugin's folder, as the studio's `show?pending` lists them.
 */
async function pendingEdits(fx: ProfileHome, name: string) {
  return (await listChanges({ home: fx.home, profile: PROFILE, profileDir: fx.dir })).pending.filter(change => change.plugin === name)
}

it('an edit to a linked, approved plugin\'s folder loads on no reload and no start until the person approves it', async () => {
  const fx = profileHome()
  const name = 'delorun-linked-edit'
  const folder = bundleFolder(fx, name, 'approved')
  linkFolder(fx, name, folder)
  // The first start under Changes approves the linked plugin as it is; then the person turns protection on.
  expect((await start(fx)).approvedAtUpgrade).toEqual([expect.objectContaining({ plugin: name })])
  await setProtection(fx.home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
  const { ctx, reconcile } = await live(fx)
  expect(evaluated(fx)).toEqual(['approved'])

  // The agent, or anyone, rewrites the module, adds a file and appends to the module in place.
  writeModule(folder, fx.marker, 'edited')
  writeFileSync(join(folder, 'extra.mjs'), 'export const added = true\n')
  appendFileSync(join(folder, 'index.mjs'), 'appendFileSync(' + JSON.stringify(fx.marker) + ', "in-place\\n")\n')
  await reconcile().catch((_refused: unknown) => { /* a reload may refuse; what matters is that nothing edited loaded */ })
  expect(evaluated(fx)).not.toContain('edited')
  expect(evaluated(fx)).not.toContain('in-place')
  expect(loadable(fx, name)).not.toContain('edited')
  await ctx.fiber.dispose()

  // The next start records the edit as a change waiting for the person and keeps the approved content.
  await start(fx)
  const second = await bootProfile(fx)
  expect(evaluated(fx)).not.toContain('edited')
  expect(evaluated(fx)).not.toContain('in-place')
  expect(loadable(fx, name)).toContain('approved')
  expect(loadable(fx, name)).not.toContain('edited')
  expect(loadable(fx, name)).not.toContain('in-place')
  await second.ctx.fiber.dispose()
  const [pending] = await pendingEdits(fx, name)
  expect(pending).toMatchObject({ kind: 'plugin-edit', plugin: name, source: folder })
  expect(active(fx, name)).not.toBe(folder)

  // Approved at the computer, it loads at the next start.
  await applyChange({ home: fx.home, profile: PROFILE, profileDir: fx.dir }, pending!.id, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), { reload: async () => undefined })
  await start(fx)
  await bootProfile(fx)
  expect(loadable(fx, name)).toContain('edited')
})

it('a fresh profile has protection off: an edit to a linked plugin loads at the next start and is logged as unreviewed', async () => {
  const fx = profileHome()
  const name = 'delorun-linked-default'
  const folder = bundleFolder(fx, name, 'approved')
  linkFolder(fx, name, folder)
  await start(fx)
  expect(await readProtection(fx.home)).toBe('off')

  writeModule(folder, fx.marker, 'edited')
  await start(fx)
  await (await bootProfile(fx)).ctx.fiber.dispose()
  expect(loadable(fx, name)).toContain('edited')
  expect(await pendingEdits(fx, name)).toEqual([])
  const { entries } = await readChangeLog(fx.home, PROFILE)
  expect(entries.some(entry => entry.decidedFrom === 'unreviewed' && entry.subject.plugin === name)).toBe(true)
})
