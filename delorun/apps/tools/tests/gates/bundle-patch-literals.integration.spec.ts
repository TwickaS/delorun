import { describe, expect, it } from 'vitest'
import { bundlePatchLiteralErrors } from '../../src/checks/gates/bundle-patch-literals.ts'
import { gatePath, REPO, runTsx, scratchRepo } from './support.ts'

const BAD = [
  '- id: a',
  '  disabled: !!js true',
  '- insert:',
  '    - id: b',
  '      name: pkg',
  '      disabled: !!js false',
  '    - id: g',
  '      group: true',
  '      config:',
  '        - id: c',
  '          name: pkg',
  '          disabled: !!js true',
  '',
].join('\n')

const MESSAGE = 'a bundle patch may only disable a row with a literal true or false; the update report cannot predict an expression'

describe('gates:bundle-patch-literals', () => {
  it('rejects a disabled !!js on a patch entry, an inserted row and a group child', (test) => {
    const repo = scratchRepo(test)
    repo.write({ 'delorun/packages/bundle-x/cordis.patch.yml': BAD })
    const file = 'delorun/packages/bundle-x/cordis.patch.yml'
    expect(bundlePatchLiteralErrors(repo.root)).toEqual([
      `${file}[0].disabled: ${MESSAGE}`,
      `${file}[1].insert[0].disabled: ${MESSAGE}`,
      `${file}[1].insert[1].config[0].disabled: ${MESSAGE}`,
    ])
    const failed = runTsx(repo.root, gatePath('bundle-patch-literals'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('[0].disabled')
  }, 60_000)

  it('accepts literals and reports a tree without packages', (test) => {
    const repo = scratchRepo(test)
    repo.write({ 'delorun/packages/bundle-x/cordis.patch.yml': '- id: a\n  disabled: true\n- insert:\n    - name: pkg\n      disabled: false\n', 'delorun/packages/other/package.json': '{}' })
    expect(bundlePatchLiteralErrors(repo.root)).toEqual([])
    expect(bundlePatchLiteralErrors(scratchRepo(test).root)).toHaveLength(1)
  })

  it('accepts the real tree', () => {
    expect(bundlePatchLiteralErrors(REPO)).toEqual([])
  })
})
