/**
 * The sharing rules: which checks the machine-wide store serves, which are security class, and what each key covers
 * beyond the declared inputs.
 */
import { describe, expect, it } from 'vitest'
import type { Check, ForkPackage, UpstreamPackage } from '../src/checks/plan.ts'
import { declarationReaders, dependencyClosure, scopedDirs, securityPackageDirs, shareRule, sharingPolicy, SHARE_RULES, type SharingFacts } from '../src/checks/sharing.ts'

const pkg = (dir: string, forkDependencies: string[] = [], buildOutputs: string[] = []): ForkPackage => ({ name: `@delo/${dir.split('/').at(-1) ?? ''}`, dir, forkDependencies, upstreamDependencies: [], ownWorkspace: false, ...buildOutputs.length > 0 ? { buildOutputs } : {} })
const upstream = (dir: string, dependencies: string[] = [], security = false): UpstreamPackage => ({ name: `@deepseek-ai/${dir.split('/').at(-1) ?? ''}`, dir, dependencies, runtimeDependencies: dependencies, specs: 1, ...security ? { security: true } : {} })
const check = (id: string, extra: Partial<Check> = {}): Check => ({ id, group: id.split(':')[0] ?? id, title: id, cwd: '', command: ['node'], needs: [], tiers: ['changed'], cpus: 1, memoryBytes: 1, budget: { memoryGiB: 1 }, inputs: ['**'], ...extra })

const packages = [
  pkg('delo/packages/trash'),
  pkg('delo/packages/plugin-trash', ['@delo/trash'], ['lib/index.js']),
  pkg('delo/packages/plugin-sidebar', ['@delo/plugin-trash']),
  pkg('delo/apps/tools', ['@delo/plugin-sidebar']),
  pkg('delo/packages/cycle-a', ['@delo/cycle-b']),
  pkg('delo/packages/cycle-b', ['@delo/cycle-a']),
]
const facts: SharingFacts = {
  packages,
  upstream: [upstream('packages/fs/tool-fs', [], true), upstream('packages/fs/tool-fs-search', ['@deepseek-ai/tool-fs']), upstream('packages/web/fetch')],
  securityPackages: ['delo/packages/trash'],
  declarationReaders: ['delo/packages/plugin-sidebar/tsconfig.json'],
}
const policy = sharingPolicy(facts)

describe('the sharing rules', () => {
  it('take an id\'s own entry, then its families\', and name no rule for an unaudited check', () => {
    expect(shareRule('typecheck:delo:cli')).toBe(SHARE_RULES['typecheck:delo'])
    expect(shareRule('typecheck:upstream')).toBe(SHARE_RULES['typecheck:upstream'])
    expect(shareRule('tests:fork:integration')).toBe(SHARE_RULES['tests:fork'])
    expect(shareRule('gates:new')).toBeUndefined()
    expect(policy.unshared(check('gates:new'))).toBe('its inputs have not been audited for sharing')
  })

  it('share an audited check and refuse one that reads history, naming the reason', () => {
    expect(policy.unshared(check('gates:package-states'))).toBeUndefined()
    expect(policy.unshared(check('parity-switches'))).toBeUndefined()
    expect(policy.unshared(check('boundary'))).toMatch(/^reads git history/)
    expect(policy.unshared(check('typecheck:upstream'))).toMatch(/^writes the declarations/)
  })

  it('mark the security-class checks, and the unscoped suites, which run the security packages', () => {
    const security = Object.keys(SHARE_RULES).filter(id => policy.security(check(id)))
    expect(security).toEqual(['boundary', 'gates:secrets', 'gates:personal-data', 'gates:infrastructure', 'gates:fundamentals', 'tests:fork', 'tests:upstream-changed'])
  })

  it('share a Delo program\'s typecheck unless the program reads emitted declarations', () => {
    const program = (config: string): Check => check(`typecheck:delo:${config}`, { command: ['tsc', '--noEmit', '-p', config] })
    expect(policy.unshared(program('delo/packages/trash/tsconfig.json'))).toBeUndefined()
    expect(policy.unshared(program('delo/packages/plugin-sidebar/tsconfig.json'))).toBe('delo/packages/plugin-sidebar/tsconfig.json reads emitted declarations, which no key covers')
    expect(policy.unshared(check('typecheck:delo:odd', { command: ['tsc'] }))).toBeUndefined()
  })

  it('refuse a fork-suite pass that runs a package reading state outside its key, and mark one that runs a security package', () => {
    const suite = (scope?: string[]): Check => check('tests:fork', scope === undefined ? {} : { scope })
    expect(policy.unshared(suite(['delo/packages/plugin-sidebar/']))).toBeUndefined()
    expect(policy.security(suite(['delo/packages/plugin-sidebar/']))).toBe(false)
    expect(policy.unshared(suite(['delo/packages/trash/']))).toBeUndefined()
    expect(policy.security(suite(['delo/packages/trash/tests/a.spec.ts']))).toBe(true)
    expect(policy.unshared(suite(['delo/apps/tools/']))).toBe('it runs the specs of delo/apps/tools, which read state outside the key')
    // The whole suite runs every package.
    expect(policy.unshared(suite())).toMatch(/delo\/apps\/tools/)
    expect(policy.security(suite())).toBe(true)
  })

  it('mark the changed-upstream lane security class when it runs a security-ledger package or a direct dependent of one', () => {
    const lane = (scope?: string[]): Check => check('tests:upstream-changed', scope === undefined ? {} : { scope })
    expect(policy.security(lane(['packages/web/fetch/']))).toBe(false)
    expect(policy.security(lane(['packages/fs/tool-fs-search/']))).toBe(true)
    expect(policy.security(lane(['packages/fs/tool-fs/']))).toBe(true)
    expect(policy.unshared(lane(['packages/fs/tool-fs/']))).toBeUndefined()
    expect(policy.stateFiles(lane())).toEqual(['packages/experimental/liveshare/lib/typert.remote-client.js'])
    expect(policy.stateFiles(check('jsdoc'))).toEqual([])
  })

  it('key the source of the Delo packages a command runs and of their dependencies, and upstream\'s scripts', () => {
    expect(policy.codeInputs(check('gates:x', { command: ['tsx', 'delo/apps/tools/src/checks/gates/x.ts'] }))).toEqual([
      'delo/apps/tools/package.json', 'delo/apps/tools/src/**',
      'delo/packages/plugin-sidebar/package.json', 'delo/packages/plugin-sidebar/src/**',
      'delo/packages/plugin-trash/package.json', 'delo/packages/plugin-trash/src/**',
      'delo/packages/trash/package.json', 'delo/packages/trash/src/**',
    ])
    expect(policy.codeInputs(check('generated:notices', { command: ['tsx', 'scripts/gen.ts', 'scripts/other.ts'] }))).toEqual(['scripts/**'])
    expect(policy.codeInputs(check('tests:fork', { command: ['vitest', 'run'] }))).toEqual([])
  })
})

describe('the package facts', () => {
  it('follow dependencies through a cycle and ignore an unknown directory', () => {
    expect(dependencyClosure(packages, ['delo/packages/cycle-a', 'delo/nowhere'])).toEqual(['delo/packages/cycle-a', 'delo/packages/cycle-b'])
  })

  it('find the package directories a scope runs', () => {
    expect(scopedDirs(['delo/packages/trash/', 'delo/packages/plugin-trash/tests/x.spec.ts'], ['delo/packages/trash', 'delo/packages/plugin-trash', 'delo/packages/tra'])).toEqual(['delo/packages/trash', 'delo/packages/plugin-trash'])
    expect(scopedDirs(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('take the security packages from the files the enforced fundamentals name', () => {
    expect(securityPackageDirs(['delo/packages/trash/src/a.ts', 'delo/packages/trash/tests/b.spec.ts', 'delo/apps/cli/src/c.ts', 'packages/fs/tool-fs/src/d.ts', 'delo/docs/x.md'])).toEqual(['delo/apps/cli', 'delo/packages/trash'])
  })

  it('list the programs that read emitted declarations: references, the CLI, and a dependency with a build', () => {
    expect(declarationReaders([
      { config: 'delo/packages/trash/tsconfig.json', references: false },
      { config: 'delo/packages/trash/tsconfig.tests.json', references: true },
      { config: 'delo/packages/plugin-trash/tsconfig.json', references: false },
      { config: 'delo/packages/plugin-sidebar/tsconfig.json', references: false },
      { config: 'delo/apps/cli/tsconfig.json', references: false },
      { config: 'tsconfig.json', references: false },
    ], packages)).toEqual(['delo/apps/cli/tsconfig.json', 'delo/packages/plugin-sidebar/tsconfig.json', 'delo/packages/trash/tsconfig.tests.json'])
  })
})
