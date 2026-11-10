/**
 * Host half of `@delo/bundle-local`'s Privacy section row. The section is a browser plugin; the Host mounts the row so
 * the browser roster lists it, and prints Delo's version and the DeepSeek Harness version into each page for the
 * version row in Settings.
 * @module @delo/bundle-local
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DELO_VERSION_ENV, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { VERSIONS_GLOBAL } from './client/versions.ts'

/**
 * The versions this harness runs: Delo's, which `delorun` exports before any upstream module runs, and the DeepSeek
 * Harness version upstream reports.
 * @param env - the process environment.
 * @returns both versions, or `undefined` when the harness was not started by `delorun` and so has no Delo version.
 */
export function harnessVersions(env: Readonly<Record<string, string | undefined>> = process.env): { delo: string, dsh: string } | undefined {
  const delo = env[DELO_VERSION_ENV]
  return delo === undefined || delo === '' ? undefined : { delo, dsh: getDshRuntimeVersion() }
}

/**
 * Print the versions into each page the web server renders, as the page global the version row reads.
 * @param ctx - the host plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => {
    const versions = harnessVersions()
    if (versions !== undefined) table.push({ kind: 'global', name: VERSIONS_GLOBAL, value: versions })
  })
}
