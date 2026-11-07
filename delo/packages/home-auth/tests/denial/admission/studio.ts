/**
 * Boot the web routes of Delo's shipped CLI composition in this process: upstream's web template, which Delo's CLI
 * profiles extend, under a temporary Harness home, with the web server on a port the operating system assigns. Delo's
 * `@delo/bundle-local` layer is left out because its host half registers no route and its browser bundle is built
 * outside upstream's `build:artifacts`. The booted web server's route tables list each shipped route, upgrade route and
 * the fallback for a spec to reach.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { WebServer, WebRouteKind } from '@deepseek-ai/dsh-host-webserver'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE } from '@delo/bundle-local/profile'

/** The bundles of Delo's CLI profiles without `@delo/bundle-local`: upstream's web template. */
const ROUTE_BUNDLES = DELO_PROFILE_BUNDLES.filter(bundle => bundle !== LOCAL_BUNDLE)

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))
const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')

/** One registration with the web server. */
export type Registration =
  | { readonly kind: WebRouteKind; readonly path: string }
  | { readonly kind: 'upgrade'; readonly path: string }
  | { readonly kind: 'fallback' }

/**
 * The registrations a web server holds, read from its private route tables. The loader imports the web server outside
 * Vitest's module graph, so a spy on the class this spec imports would see none of them. The read fails loudly when
 * the tables are not where it expects them.
 * @param server - the booted web server.
 * @returns its exact, prefix and upgrade routes, and the fallback when one is registered.
 */
function registrationsOf(server: WebServer): Registration[] {
  const table = (field: string): Map<string, unknown> => {
    const value: unknown = Reflect.get(server, field)
    if (!(value instanceof Map)) throw new Error(`studio: the web server has no ${field} route table`)
    return value as Map<string, unknown>
  }
  return [
    ...[...table('exact').keys()].map(path => ({ kind: 'exact' as const, path })),
    ...[...table('prefixes').keys()].map(path => ({ kind: 'prefix' as const, path })),
    ...[...table('upgrades').keys()].map(path => ({ kind: 'upgrade' as const, path })),
    ...(Reflect.get(server, 'fallback') === undefined ? [] : [{ kind: 'fallback' as const }]),
  ]
}

/** A booted studio. */
export interface Studio {
  readonly ctx: Context
  /** Every registration the web server holds once boot has settled. */
  readonly registrations: readonly Registration[]
  /** Dispose the composition and remove the home. */
  readonly close: () => Promise<void>
}

/**
 * Boot the studio's web composition.
 * @param trustedHosts - `--trusted-host` values for the loopback listener.
 * @returns the booted studio.
 */
export async function bootStudio(trustedHosts: readonly string[] = []): Promise<Studio> {
  const home = mkdtempSync(join(tmpdir(), 'delo-admission-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const profileDir = join(home, 'profiles', 'default')
  initProfile(profileDir, ROUTE_BUNDLES)
  const restore = (): void => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  try {
    const profile = loadProfileDirectory('delorun', profileDir, INSTALL_ANCHOR, { userLayer: false })
    const rootConfig = join(profileDir, 'cordis.yml')
    writeFileSync(rootConfig, '[]\n')
    const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile })
    const ctx = await boot('delorun', rootConfig, profile.layers.flatMap(layer => layer.patches), async (root) => {
      const profileContext: ProfileContext = {
        name: 'default', dir: profile.dir, patchPath: profile.patchPath, installAnchor: INSTALL_ANCHOR,
        cwd: home, home, startedBundles: profile.layers.map(layer => layer.packageName),
        overlays: [], telemetryDisabledEnv: '1',
      }
      root.provide('profileContext', profileContext)
      root.provide('cmdlineArgs', { get: () => ['--port', '0', '--no-open', ...trustedHosts.flatMap(host => ['--trusted-host', host])] })
      root.provide('appExit', (code: number) => { throw new Error(`studio requested exit ${String(code)}`) })
      root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      await root.plugin(PluginPackages, { resolution })
    })
    return {
      ctx,
      registrations: registrationsOf(ctx.webServer),
      close: async () => {
        try {
          await ctx.fiber.dispose()
        } finally {
          restore()
          rmSync(home, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    restore()
    rmSync(home, { recursive: true, force: true })
    throw error
  }
}
