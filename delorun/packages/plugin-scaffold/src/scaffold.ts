/**
 * The files `delorun plugin new` and the studio's Create a plugin write for each plugin kind, computed without touching the disk: the package
 * manifest, the bundle patch, the sources and build configuration where the kind has code, the locale file the plugin
 * list reads, and the README. Every file is a path relative to the new folder and its text.
 *
 * @module @delorun/plugin-scaffold/scaffold
 */
import semver from 'semver'
import { bundleTemplate, presetTemplate, readme, toolTemplate, uiTemplate, type KindTemplate } from './templates.ts'

/**
 * The range that targets a Delorun release's minor: every patch of it, and no later minor.
 * @param delorun - the running Delorun version.
 * @returns `^<major>.<minor>.0`, which before 1.0 admits only that minor's patches.
 */
export function targetRange(delorun: string): string {
  return `^${String(semver.major(delorun))}.${String(semver.minor(delorun))}.0`
}

/** The kinds of plugin the command scaffolds. */
export const PLUGIN_KINDS = ['tool', 'preset', 'ui', 'bundle'] as const

/** One kind of plugin. */
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/**
 * The toolchain versions a generated package with a build declares: the versions this repository builds its own
 * packages with, so a scaffold builds with a tsdown whose options its configuration uses.
 */
export const TOOLCHAIN = {
  typescript: '^6.0.3',
  tsdown: '^0.22.2',
  react: '^18.2.0',
  '@types/react': '~18.3.1',
} as const

/** What a scaffold is made from. */
export interface ScaffoldPlan {
  /** The package name. */
  readonly name: string
  /** The kind of plugin. */
  readonly kind: PluginKind
  /** The running DSH version. */
  readonly dsh: string
  /** The running Delorun version. */
  readonly delorun: string
  /** The `@deepseek-ai/cordis` version the installation runs. */
  readonly cordis: string
}

/** One file of a scaffold. */
export interface ScaffoldFile {
  /** The path relative to the new folder, with `/` separators. */
  readonly path: string
  /** The file's text, ending in one newline. */
  readonly text: string
}

/** The names a scaffold derives from its package name. */
export interface ScaffoldNames {
  /** The package name. */
  readonly name: string
  /** The package name without its scope: the default folder name. */
  readonly bare: string
  /** The id of the row the bundle patch inserts: the name without `@`, other characters outside `[a-z0-9-]` as `-`. */
  readonly rowId: string
  /** The model-visible tool name of a tool plugin: the bare name, characters outside `[a-z0-9_]` as `_`. */
  readonly toolName: string
  /** The sentence-case title the plugin list shows: the bare name's words, the first capitalized. */
  readonly title: string
}

/**
 * The package name without its scope.
 * @param name - a package name.
 * @returns the part after `@scope/`, or the name itself.
 */
export function bareName(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
}

/**
 * The names a scaffold derives from a package name.
 * @param name - a valid package name.
 * @returns the derived names.
 */
export function scaffoldNames(name: string): ScaffoldNames {
  const bare = bareName(name)
  const words = bare.split(/[^a-z0-9]+/u).filter(word => word !== '')
  const sentence = words.join(' ')
  return {
    name,
    bare,
    rowId: name.replace(/^@/u, '').replace(/[^a-z0-9-]+/gu, '-'),
    toolName: bare.replace(/[^a-z0-9_]+/gu, '_').slice(0, 64),
    title: sentence === '' ? bare : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`,
  }
}

/** The JSON value of a `package.json`, written with keys in this order. */
type Manifest = Readonly<Record<string, unknown>>

/**
 * The package manifest of a scaffold.
 * @param plan - what the scaffold is made from.
 * @param template - the kind's template.
 * @returns the manifest.
 */
export function scaffoldManifest(plan: ScaffoldPlan, template: KindTemplate): Manifest {
  const dshRange = `^${plan.dsh}`
  const cordisRange = `~${plan.cordis}`
  const shared = Object.fromEntries([
    ['@deepseek-ai/cordis', cordisRange],
    ...template.sharedDsh.map(name => [name, dshRange] as const),
  ].sort(([left], [right]) => left!.localeCompare(right!)))
  const types = Object.fromEntries(template.typesDsh.map(name => [name, dshRange] as const))
  const build = template.build
  return {
    name: plan.name,
    version: '0.1.0',
    description: template.description,
    type: 'module',
    ...build === undefined ? {} : { main: './lib/index.js' },
    exports: {
      ...build === undefined ? {} : { '.': './lib/index.js' },
      ...build?.client === true ? { './client': './lib/client.js' } : {},
      './cordis.patch.yml': './cordis.patch.yml',
      './locale/*.json': './locale/*.json',
      './package.json': './package.json',
    },
    files: [
      ...build === undefined ? [] : ['lib/index.js'],
      ...build?.client === true ? ['lib/client.js'] : [],
      'cordis.patch.yml',
      'locale/*.json',
    ],
    ...build === undefined ? {} : { scripts: { build: 'tsdown', prepare: 'tsdown', typecheck: 'tsc --noEmit' } },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...template.client === undefined ? {} : { client: template.client },
    },
    engines: { dsh: dshRange, delorun: targetRange(plan.delorun) },
    ...build === undefined ? {} : {
      peerDependencies: shared,
      devDependencies: Object.fromEntries(Object.entries({
        ...shared,
        ...types,
        ...Object.fromEntries(build.toolchain.map(name => [name, TOOLCHAIN[name]] as const)),
      }).sort(([left], [right]) => left.localeCompare(right))),
    },
  }
}

/**
 * The template of a kind.
 * @param kind - the kind.
 * @param names - the derived names.
 * @returns the kind's template.
 */
function kindTemplate(kind: PluginKind, names: ScaffoldNames): KindTemplate {
  switch (kind) {
    case 'tool': return toolTemplate(names)
    case 'preset': return presetTemplate(names)
    case 'ui': return uiTemplate(names)
    case 'bundle': return bundleTemplate(names)
  }
}

/**
 * Every file of a scaffold, `package.json` first.
 * @param plan - what the scaffold is made from.
 * @returns the files, each path relative to the new folder.
 */
export function scaffoldFiles(plan: ScaffoldPlan): ScaffoldFile[] {
  const names = scaffoldNames(plan.name)
  const template = kindTemplate(plan.kind, names)
  return [
    { path: 'package.json', text: `${JSON.stringify(scaffoldManifest(plan, template), null, 2)}\n` },
    { path: 'cordis.patch.yml', text: template.patch },
    { path: 'locale/en.json', text: `${JSON.stringify({ meta: { title: names.title, description: template.description } }, null, 2)}\n` },
    ...template.files,
    { path: 'README.md', text: readme(names, plan.kind, template) },
  ]
}
