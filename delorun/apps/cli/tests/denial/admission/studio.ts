/**
 * Boot the web routes of Delorun's shipped CLI composition in this process: upstream's web template, which Delorun's CLI
 * profiles extend, under a temporary Harness home, with the web server on a port the operating system assigns. By default
 * Delorun's `@delorun/bundle-local` layer is left out, so a spec mounts its own authenticator provider. With `local` the
 * composition is the whole CLI profile, `@delorun/home-auth`, `@delorun/reach` and the trash included: the profile links the
 * bundle as `delorun setup` does for a source checkout, and the loader imports Delorun's TypeScript sources through tsx's
 * ESM hook, as the `delorun` source launch does, registered until the studio closes. The booted web server's route
 * tables list each shipped route, upgrade route and the fallback for a spec to reach.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { WebServer, WebRouteKind } from '@deepseek-ai/dsh-host-webserver'
import { DELORUN_PROFILE_BUNDLES, LOCAL_BUNDLE } from '@delorun/bundle-local/profile'

/** The bundles of Delorun's CLI profiles without `@delorun/bundle-local`: upstream's web template and the studio bundle. */
const ROUTE_BUNDLES = DELORUN_PROFILE_BUNDLES.filter(bundle => bundle !== LOCAL_BUNDLE)

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))
const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')
const LOCAL_PACKAGE_DIR = join(REPO, 'delorun/packages/bundle-local')

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

/**
 * A request target that reaches one registration: an exact or upgrade route's own path, a path under a prefix, and for
 * the fallback a path no route claims.
 * @param registration - the registration.
 * @returns the target, and whether it is an upgrade.
 */
export function targetOf(registration: Registration): { readonly path: string; readonly upgrade: boolean } {
  switch (registration.kind) {
    case 'exact': return { path: registration.path, upgrade: false }
    case 'prefix': return { path: `${registration.path}/admission-probe`, upgrade: false }
    case 'upgrade': return { path: registration.path, upgrade: true }
    case 'fallback': return { path: '/admission-probe-fallback', upgrade: false }
    default: {
      const unknown: never = registration
      throw new Error(`unknown registration ${JSON.stringify(unknown)}`)
    }
  }
}

/** A booted studio. */
export interface Studio {
  readonly ctx: Context
  /** The temporary Harness home the studio runs in. */
  readonly home: string
  /** Every registration the web server holds once boot has settled. */
  readonly registrations: readonly Registration[]
  /** Dispose the composition and remove the home. */
  readonly close: () => Promise<void>
}

/** Options of {@link bootStudio}. */
export interface StudioOptions {
  /** Boot every bundle of Delorun's CLI profiles, `@delorun/bundle-local` included. */
  readonly local?: boolean
}

/**
 * Boot the studio's web composition.
 * @param trustedHosts - `--trusted-host` values for the loopback listener.
 * @param options - which bundles the composition holds.
 * @returns the booted studio.
 */
export async function bootStudio(trustedHosts: readonly string[] = [], options: StudioOptions = {}): Promise<Studio> {
  const home = mkdtempSync(join(tmpdir(), 'delorun-admission-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const profileDir = join(home, 'profiles', 'default')
  initProfile(profileDir, options.local === true ? DELORUN_PROFILE_BUNDLES : ROUTE_BUNDLES)
  let unregister = async (): Promise<void> => {}
  if (options.local === true) {
    const link = join(profileDir, 'node_modules', LOCAL_BUNDLE)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(LOCAL_PACKAGE_DIR, link, 'junction')
    const { register } = await import('tsx/esm/api')
    unregister = register()
  }
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
      home,
      registrations: registrationsOf(ctx.webServer),
      close: async () => {
        try {
          await ctx.fiber.dispose()
        } finally {
          restore()
          await unregister()
          rmSync(home, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    restore()
    await unregister()
    rmSync(home, { recursive: true, force: true })
    throw error
  }
}
