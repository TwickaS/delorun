/**
 * The bench's own fixture plugins, written to a folder as plain built packages (a host half in `lib/index.js` and a
 * studio half in `lib/client.js` in the client module loader's format, the output `delorun plugin new --kind ui` builds):
 *
 * - `bench-fixture-minimal`: a minimal Settings section; declares both `engines` ranges the running hosts satisfy.
 * - `bench-fixture-broken`: its host half throws while loading, so the studio logs a load error.
 * - `bench-fixture-engines-delorun`: only `engines.delorun`.
 * - `bench-fixture-engines-dsh`: only `engines.dsh`.
 * - `bench-fixture-engines-both`: both, with an `engines.dsh` no DSH version satisfies, so what each host does with a
 *   range it cannot meet shows (A567, L150: Delorun's own pin decides alone once the change lands; today `engines.dsh`
 *   decides on Delorun too, and the card records which).
 *
 * None of them does anything but draw a page; a fixture is never a hostile plugin.
 *
 * @module @delorun/tools/compat-bench/fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One fixture. */
export interface Fixture {
  /** The package name and folder name. */
  readonly name: string
  /** What the fixture is for. */
  readonly purpose: string
  /** The `engines` block, or none. */
  readonly engines?: Readonly<{ delorun?: string, dsh?: string }>
  /** Whether the host half throws while loading. */
  readonly breaks?: boolean
}

/** A Delorun 0.1 prerelease range, and a DSH range the current upstream base satisfies. */
export const DELORUN_RANGE = '^0.1.0-0'
/** A range of DSH versions that includes the release candidates the bench's stock image runs. */
export const DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'
/** A range no DSH version satisfies. */
export const UNSATISFIABLE_RANGE = '^99.0.0'

/** The five fixtures. */
export const FIXTURES: readonly Fixture[] = [
  { name: 'bench-fixture-minimal', purpose: 'a minimal Settings section', engines: { delorun: DELORUN_RANGE, dsh: DSH_RANGE } },
  { name: 'bench-fixture-broken', purpose: 'a plugin that fails to load', engines: { delorun: DELORUN_RANGE, dsh: DSH_RANGE }, breaks: true },
  { name: 'bench-fixture-engines-delorun', purpose: 'only engines.delorun', engines: { delorun: DELORUN_RANGE } },
  { name: 'bench-fixture-engines-dsh', purpose: 'only engines.dsh', engines: { dsh: DSH_RANGE } },
  { name: 'bench-fixture-engines-both', purpose: 'both engines, the dsh range unsatisfiable', engines: { delorun: DELORUN_RANGE, dsh: UNSATISFIABLE_RANGE } },
]

/**
 * The studio half, in the format the studio's client module loader runs: one script that hands a factory to
 * `window.__ModuleLoader__.load`, takes React and the slot registry from the page, and registers a Settings section.
 * @param name - the package name, which is the loader id.
 * @returns the script.
 */
export function clientSource(name: string): string {
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require('react');
function Section() {
  return React.createElement('section', null,
    React.createElement('h2', null, 'Bench fixture'),
    React.createElement('p', null, 'This page comes from the ${name} plugin.'));
}
exports.inject = ['slots'];
exports.apply = function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: ${JSON.stringify(name)}, order: 100, label: 'Bench fixture' }, Section));
};
return module.exports; } });
`
}

/**
 * The host half.
 * @param fixture - the fixture.
 * @returns the module's source.
 */
export function hostSource(fixture: Fixture): string {
  return `export const name = ${JSON.stringify(fixture.name)}\n\nexport function apply() {\n${fixture.breaks === true ? `  throw new Error('${fixture.name} cannot load: fixture failure on purpose')\n` : ''}}\n`
}

/**
 * Write every fixture under a folder.
 * @param root - the folder, which exists.
 * @returns the fixture folders by name.
 */
export function writeFixtures(root: string): Map<string, string> {
  const written = new Map<string, string>()
  for (const fixture of FIXTURES) {
    const dir = join(root, fixture.name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    const manifest = {
      name: fixture.name, version: '0.1.0', description: `Bench fixture: ${fixture.purpose}.`, type: 'module', main: './lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js', './cordis.patch.yml': './cordis.patch.yml', './locale/*.json': './locale/*.json', './package.json': './package.json' },
      files: ['lib', 'locale', 'cordis.patch.yml'], license: 'MIT',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } },
      ...(fixture.engines === undefined ? {} : { engines: fixture.engines }),
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: '${fixture.name}'\n      name: '${fixture.name}'\n`)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'locale', 'en.json'), `${JSON.stringify({ meta: { title: 'Bench fixture', description: `Bench fixture: ${fixture.purpose}.` } }, null, 2)}\n`)
    writeFileSync(join(dir, 'lib', 'index.js'), hostSource(fixture))
    writeFileSync(join(dir, 'lib', 'client.js'), clientSource(fixture.name))
    written.set(fixture.name, dir)
  }
  return written
}
