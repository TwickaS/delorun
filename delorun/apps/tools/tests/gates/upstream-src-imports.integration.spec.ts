import { describe, expect, it } from 'vitest'
import { specifiers, upstreamSourceImportErrors } from '../../src/checks/gates/upstream-src-imports.ts'
import { gatePath, runTsx, scratchRepo } from './support.ts'

describe('gates:upstream-src-imports', () => {
  it('reads static, re-export, dynamic and type imports with positions', () => {
    const text = 'import a from \'a\'\nexport * from \'b\'\nconst c = await import(\'c\')\ntype T = import(\'d\').T\n'
    expect(specifiers('x.ts', text).map(found => `${found.position} ${found.specifier}`)).toEqual(['1:15 a', '2:15 b', '3:24 c', '4:17 d'])
  })

  it('rejects each way a Delorun source reaches upstream source and accepts entries and Delorun paths', (test) => {
    const repo = scratchRepo(test)
    repo.write({
      'delorun/packages/home/src/bad.ts': [
        'import { a } from \'@deepseek-ai/dsh-tool-fs/src/consent.ts\'',
        'export { b } from \'../../../../packages/boot/plugin-manager/src/x.ts\'',
        'export const c = import(\'@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts\')',
      ].join('\n'),
      'delorun/packages/home/src/good.ts': [
        'import { a } from \'@deepseek-ai/dsh-tool-fs\'',
        'import { d } from \'./bad.ts\'',
        'import { e } from \'../../changes/src/index.ts\'',
      ].join('\n'),
      'delorun/packages/home/tests/spec.ts': 'import { a } from \'@deepseek-ai/dsh-tool-fs/src/consent.ts\'\n',
    })
    expect(upstreamSourceImportErrors(repo.root)).toEqual([
      'delorun/packages/home/src/bad.ts:1:19: imports upstream source \'@deepseek-ai/dsh-tool-fs/src/consent.ts\'; import the package entry and export what it lacks',
      'delorun/packages/home/src/bad.ts:2:19: imports upstream source \'../../../../packages/boot/plugin-manager/src/x.ts\'; import the package entry and export what it lacks',
      'delorun/packages/home/src/bad.ts:3:25: imports upstream source \'@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts\'; import the package entry and export what it lacks',
    ])
    expect(upstreamSourceImportErrors(scratchRepo(test).root)).toEqual(['delorun/: no Delorun tree at the repository root, so there are no sources to check'])
  })

  it('exits 1 with the violation and 0 on a clean tree, from the command line', (test) => {
    const bad = scratchRepo(test)
    bad.write({ 'delorun/apps/cli/src/a.ts': 'import { a } from \'@deepseek-ai/dsh-tool-fs/src/consent.ts\'\n' })
    const failed = runTsx(bad.root, gatePath('upstream-src-imports'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/apps/cli/src/a.ts:1:19')

    const good = scratchRepo(test)
    good.write({ 'delorun/apps/cli/src/a.ts': 'import { a } from \'@deepseek-ai/dsh-tool-fs\'\n' })
    expect(runTsx(good.root, gatePath('upstream-src-imports')).status).toBe(0)
  }, 60_000)
})
