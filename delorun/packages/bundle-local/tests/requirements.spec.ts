/**
 * The Host check of what an optional bundle's rows need: each kind of need, the texts and fix a bundle declares, and a
 * bundle whose declaration is broken reporting a problem without stopping another bundle's answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUIREMENT_ROUTES } from '../src/client/requirements-api.ts'
import { apply, checkRequirements, hostEnvironment, isMet, type BundleToCheck, type CheckEnvironment, type Need } from '../src/requirements.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A computer with these files, variables and platform. */
function computer(files: readonly string[], env: Record<string, string> = {}, platform: NodeJS.Platform = 'linux'): CheckEnvironment {
  return { platform, env: { PATH: '/usr/bin:/opt/bin', ...env }, isExecutable: path => files.includes(path) }
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
    expect(isMet(need, computer(['/opt/bin/tool']))).toBe(true)
    expect(isMet(need, computer(['/opt/bin/tool.exe']))).toBe(false)
    expect(isMet(need, { ...computer(['C:\\bin\\tool.cmd'], { PATH: 'C:\\bin' }, 'win32'), isExecutable: path => path.endsWith('tool.cmd') })).toBe(true)
    expect(isMet(need, computer([]))).toBe(false)
  })

  it('finds a program at a listed absolute path when it is not on PATH', () => {
    const need = { kind: 'program', names: ['tool'], paths: ['/Applications/Tool'] } satisfies Need
    expect(isMet(need, computer(['/Applications/Tool']))).toBe(true)
    expect(isMet(need, computer([]))).toBe(false)
  })

  it('treats a variable that is unset or empty as unmet', () => {
    const need = { kind: 'env', name: 'SECRET' } satisfies Need
    expect(isMet(need, computer([], { SECRET: 'x' }))).toBe(true)
    expect(isMet(need, computer([], { SECRET: '' }))).toBe(false)
    expect(isMet(need, computer([]))).toBe(false)
  })

  it('meets a platform only on the platforms it lists', () => {
    const need = { kind: 'platform', os: ['darwin', 'linux'] } satisfies Need
    expect(isMet(need, computer([]))).toBe(true)
    expect(isMet(need, computer([], {}, 'win32'))).toBe(false)
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

describe('the real computer', () => {
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
