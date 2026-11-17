/**
 * The Host check of what an optional bundle's rows need: each kind of need, the texts and fix a bundle declares, and a
 * bundle whose declaration is broken reporting a problem without stopping another bundle's answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIREMENT_ROUTES } from '../src/client/requirements-api.ts'
import { apply, checkRequirements, hostEnvironment, isMet, type BundleToCheck, type CheckEnvironment, type Need } from '../src/requirements.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A computer with these files, variables and platform. */
function computer(files: readonly string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): CheckEnvironment {
  return {
    platform, env: { PATH: '/usr/bin:/opt/bin', ...env }, home: '/home/person', isExecutable: path => files.includes(path),
    exists: path => files.includes(path),
    readJson: (path) => { throw new Error(`unexpected read of ${path}`) },
    resolvePackage: (_from, name) => { throw new Error(`unexpected resolution of ${name}`) },
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
  function playwrightComputer(files: string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): CheckEnvironment {
    const manifests: Record<string, string> = {
      '@test/provider': '/bundle/node_modules/@test/provider/package.json',
      '@playwright/mcp': '/store/@playwright/mcp/package.json',
      'playwright-core': '/store/playwright-core/package.json',
    }
    return {
      ...computer(files, env, platform), exists: path => files.includes(path),
      resolvePackage: (_from, name) => manifests[name] ?? (() => { throw new Error(`cannot resolve ${name}`) })(),
      readJson: path => path === '/store/@playwright/mcp/package.json' ? { name: '@playwright/mcp', version: '0.0.80' } : browsers,
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

  it('reads Playwright\'s cache where Playwright does', () => {
    const met = (files: string[], env: Record<string, string>, platform: NodeJS.Platform) =>
      isMet(need, playwrightComputer(files, env, platform), '/bundle')
    const both = (cache: string) => [`${cache}/chromium-1243/INSTALLATION_COMPLETE`, `${cache}/chromium_headless_shell-1243/INSTALLATION_COMPLETE`]
    expect(met(both('/elsewhere'), { PLAYWRIGHT_BROWSERS_PATH: '/elsewhere' }, 'linux')).toBe(true)
    expect(met(both('/store/playwright-core/.local-browsers'), { PLAYWRIGHT_BROWSERS_PATH: '0' }, 'linux')).toBe(true)
    expect(met(both('/xdg/ms-playwright'), { XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(true)
    expect(met(both('/home/person/Library/Caches/ms-playwright'), {}, 'darwin')).toBe(true)
    expect(met(both('/home/person/.cache/ms-playwright'), {}, 'darwin')).toBe(false)
  })

  it.each([
    ['a package it cannot resolve', { row: { needs: [{ ...need, via: ['@test/missing'] }], fix: { kind: 'playwright-install' } } }],
    ['a browser its Playwright does not list', { row: { needs: [{ ...need, browser: 'webkit' }], fix: { kind: 'playwright-install' } } }],
    ['an installer fix without a Playwright browser need', { row: { needs: [program], fix: { kind: 'playwright-install' } } }],
    ['an unknown browser', { row: { needs: [{ ...need, browser: 'edge' }], fix: { kind: 'playwright-install' } } }],
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
      get: (name: string) => name === 'pluginManager'
        ? { listBundles: async () => [{ name: target.name, availability: 'profile', rows: [{ rowId: 'row' }] }] }
        : { installAnchor: target.dir, dir: target.dir },
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
})
