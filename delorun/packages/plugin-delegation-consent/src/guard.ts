/**
 * The tool guard that keeps the model's `plugin_manager` from bringing in an external agent: it refuses a call that
 * installs or enables a bundle of an external-agent package, or enables or configures a Loader row whose module belongs
 * to one. An external-agent package is a `@deepseek-ai/dsh-subagent-*` or `@deepseek-ai/dsh-experimental-subagent-*`
 * package whose provider has no local child session ({@link isExternalAgentPackage}); `dsh-subagent-acp`, whose
 * `command` runs any program, is one. A target is read the way plugin management reads it (upstream's
 * `specPackageName`), case-folded and trimmed, and through an npm alias and a relative path's last package segments,
 * so a spelling of one of those packages is refused as the package itself.
 *
 * @module @delorun/plugin-delegation-consent/guard
 */
import { resolve } from 'node:path'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { specPackageName } from '@deepseek-ai/dsh-plugin-manager'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** The model-facing refusal of a `plugin_manager` call that would bring in an external agent. */
export const PLUGIN_MANAGER_REFUSAL = 'Plugin management refused this change: it would install, enable or reconfigure an external agent '
  + '(such as Claude Code or Codex), which runs outside Delorun\'s sandbox and uses the person\'s own account. Only the person can add it, '
  + 'from the Plugins page or the first-run setup; tell them, and do not retry.'

/** The subagent packages whose provider runs a child session in this process, so the consent's review never sees it. */
const IN_PROCESS_SUBAGENTS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
])

/** A subagent provider package of DeepSeek Harness, stable or experimental. */
const SUBAGENT_PACKAGE = /^@deepseek-ai\/dsh-(?:experimental-)?subagent-[a-z0-9._~-]+$/

/** An npm alias, `npm:<spec>` alone or after an installed name and `@`. */
const NPM_ALIAS = /(?:^|@)npm:(.+)$/

/** A path's last scoped package segments, `@scope/name`, or its last segment. */
const PATH_PACKAGE = /(@[^/\\]+[/\\][^/\\]+|[^/\\]+)[/\\]?$/

/**
 * Whether a package name is an external agent's: a subagent provider package of DeepSeek Harness that does not run
 * its child session in this process.
 * @param name - the package name, case-folded.
 * @returns true for an external-agent package.
 */
export function isExternalAgentPackage(name: string): boolean {
  return SUBAGENT_PACKAGE.test(name) && !IN_PROCESS_SUBAGENTS.has(name)
}

/** Where plugin management reads saved dependencies and relative local paths. */
export interface GuardProfile {
  /** The profile directory. */
  readonly dir: string
  /** The profile's saved dependencies. */
  readonly dependencies: Readonly<Record<string, string>>
}

/**
 * The profile the Host runs, as plugin management reads it.
 * @param dir - the profile directory, or undefined without a profile.
 * @returns the directory and its saved dependencies; none while the manifest cannot be read.
 */
export function guardProfile(dir: string | undefined): GuardProfile | undefined {
  if (dir === undefined) return undefined
  try {
    return { dir, dependencies: readProfileManifest('dsh', dir).dependencies ?? {} }
  } catch (_unreadable) {
    // Plugin management refuses a profile whose manifest it cannot read; the guard still reads the target's own text.
    return { dir, dependencies: {} }
  }
}

/**
 * Every package name a `plugin_manager` target may install or name: the spec itself, plugin management's own reading
 * of it, an npm alias's target, and a local path's declared name and last package segments, each case-folded.
 * @param target - the call's target.
 * @param profile - the profile, when the Host runs one.
 * @returns the candidate names.
 */
export function targetPackageNames(target: string, profile: GuardProfile | undefined): readonly string[] {
  const typed = target.trim()
  const spec = typed.toLowerCase()
  const names = new Set<string>([spec])
  // The typed spec matches a saved git or tarball spec as written; the case-folded one names a registry package.
  for (const each of [typed, spec]) {
    const known = specPackageName(each, profile?.dependencies ?? {}, profile?.dir ?? '/')
    if (known !== undefined) names.add(known.toLowerCase())
  }
  if (/^(?:\.{1,2}[/\\]|file:|link:)/.test(spec) && profile !== undefined) {
    const declared = specPackageName(`file:${resolve(profile.dir, typed.replace(/^(?:file|link):/i, ''))}`, {}, profile.dir)
    if (declared !== undefined) names.add(declared.toLowerCase())
  }
  if (/[/\\]/.test(spec)) names.add((PATH_PACKAGE.exec(spec)?.[1] ?? spec).replaceAll('\\', '/'))
  const alias = NPM_ALIAS.exec(spec)?.[1]
  if (alias !== undefined) for (const name of targetPackageNames(alias, profile)) names.add(name)
  return [...names]
}

/**
 * The package a Loader row's module is loaded from: its scope and name, without a subpath.
 * @param moduleName - the row's module name.
 * @returns the package name, case-folded.
 */
export function modulePackage(moduleName: string): string {
  const segments = moduleName.trim().toLowerCase().split('/')
  return (moduleName.trim().startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)).join('/')
}

/** The Loader rows the guard resolves an entry target against: each row's entry id, row id and module name. */
export interface GuardRow {
  readonly id: string
  readonly rowId: string | undefined
  readonly name: string
}

/**
 * Decide one tool call: refuse a `plugin_manager` call that installs or enables an external-agent package's bundle, or
 * enables or configures a row of one. Disabling, removing and every other action pass.
 * @param exec - the tool call.
 * @param rows - the Loader's rows, read when the call names an entry.
 * @param profile - the profile, read when the call names a bundle.
 * @returns the refusal, or undefined.
 */
export function pluginManagerVerdict(
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
  rows: () => readonly GuardRow[],
  profile: () => GuardProfile | undefined,
): string | undefined {
  if (exec.name !== 'plugin_manager' || typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  const action: unknown = Reflect.get(exec.arguments, 'action')
  const target: unknown = Reflect.get(exec.arguments, 'target')
  const enabled: unknown = Reflect.get(exec.arguments, 'enabled')
  if (typeof target !== 'string') return undefined
  switch (action) {
    case 'install_bundle':
    case 'set_bundle':
      return enabled !== false && targetPackageNames(target, profile()).some(isExternalAgentPackage) ? PLUGIN_MANAGER_REFUSAL : undefined
    case 'set_plugin':
    case 'configure': {
      if (action === 'set_plugin' && enabled === false) return undefined
      const row = rows().find(each => each.id === target.trim() || each.rowId === target.trim())
      return row !== undefined && isExternalAgentPackage(modulePackage(row.name)) ? PLUGIN_MANAGER_REFUSAL : undefined
    }
    default:
      return undefined
  }
}
