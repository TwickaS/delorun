/** Package names read from installation specs. */
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { dependencySpec, InvalidInstallSpecError, parseInstallSpec, type ParsedInstallSpec } from './install-spec.ts'
import { sshGitSpec } from './git-transport.ts'

/**
 * The package an installation spec names before pnpm runs: a registry name, a local directory's manifest name, or the
 * dependency saved with this git or tarball spec or the SSH form of its Git URL, compared as the plugin list shows saved specs.
 * @param spec The installation spec.
 * @param dependencies The profile's saved dependencies.
 * @param profileDir The profile directory saved local paths are relative to.
 * @returns The package name, or `undefined` when only the installation tells it.
 */
export function specPackageName(spec: string, dependencies: Readonly<Record<string, string>>, profileDir: string): string | undefined {
  const parsed = parsedForRegistry(spec)
  if (parsed.kind === 'registry') return parsed.name
  if (parsed.kind === 'path') return packageName(parsed.path)
  const alternative = parsed.kind === 'tarball' && parsed.path !== undefined ? `file:${parsed.path}` : sshGitSpec(parsed)
  const specs = alternative === undefined ? [spec] : [spec, alternative]
  return Object.entries(dependencies).find(([dependency, saved]) => specs.includes(dependencySpec(dependency, saved, profileDir)))?.[0]
}

/** The package name a local directory declares, or `undefined` without a readable manifest. */
export function packageName(dir: string): string | undefined {
  try {
    return readProfileManifest('dsh', dir).name
  } catch (_error) {
    // pnpm reports the unreadable directory itself.
    return undefined
  }
}

/** The spec's form, for deciding whether a failed attempt was the registry's; a form the parser refuses has no host of its own. */
export function parsedForRegistry(spec: string): ParsedInstallSpec {
  try {
    return parseInstallSpec(spec)
  } catch (error) {
    /* v8 ignore next -- parseInstallSpec throws nothing but its own refusal */
    if (!(error instanceof InvalidInstallSpecError)) throw error
    return { kind: 'registry', spec, name: spec }
  }
}
