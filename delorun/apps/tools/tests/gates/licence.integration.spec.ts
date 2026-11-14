import { describe, expect, it } from 'vitest'
import { licenceErrors } from '../../src/checks/gates/licence.ts'
import { scratchRepo, runTsx, gatePath } from './support.ts'

const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2026 Fixture\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n'

describe('gates:licence', () => {
  it('passes a tree whose packages and root LICENSE are MIT', (test) => {
    const repo = scratchRepo(test)
    repo.write({
      'LICENSE': MIT_LICENSE,
      'delorun/apps/tools/package.json': JSON.stringify({ name: '@delorun/tools', license: 'MIT' }),
      'delorun/packages/core/package.json': JSON.stringify({ name: '@delorun/core', license: 'MIT' }),
    })
    expect(licenceErrors(repo.root)).toEqual([])
  })

  it('refuses a Delorun package that declares another licence, and one that declares none', (test) => {
    const repo = scratchRepo(test)
    repo.write({
      'LICENSE': MIT_LICENSE,
      'delorun/packages/core/package.json': JSON.stringify({ name: '@delorun/core', license: 'Apache-2.0' }),
      'delorun/apps/web/package.json': JSON.stringify({ name: '@delorun/web' }),
      'delorun/apps/web/node_modules/dep/package.json': JSON.stringify({ license: 'Apache-2.0' }),
    })
    expect(licenceErrors(repo.root).sort()).toEqual([
      'delorun/apps/web/package.json: declares no licence, not MIT',
      'delorun/packages/core/package.json: declares Apache-2.0, not MIT',
    ])
  })

  it('refuses a root LICENSE that is not the MIT licence text, and a tree with no Delorun packages', (test) => {
    const repo = scratchRepo(test)
    repo.write({ 'LICENSE': 'Apache License\nVersion 2.0\n', 'delorun/packages/core/package.json': JSON.stringify({ license: 'MIT' }) })
    expect(licenceErrors(repo.root)).toEqual(['LICENSE: the root licence is not the MIT licence text'])

    const bare = scratchRepo(test)
    bare.write({ 'LICENSE': MIT_LICENSE })
    expect(licenceErrors(bare.root)).toEqual(['delorun/: no Delorun tree at the repository root, so there are no packages to check'])
  })

  it('exits 1 with the violation and 0 on a clean tree, from the command line', (test) => {
    const bad = scratchRepo(test)
    bad.write({ 'LICENSE': MIT_LICENSE, 'delorun/packages/core/package.json': JSON.stringify({ license: 'ISC' }) })
    const failed = runTsx(bad.root, gatePath('licence'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/packages/core/package.json: declares ISC, not MIT')

    const good = scratchRepo(test)
    good.write({ 'LICENSE': MIT_LICENSE, 'delorun/packages/core/package.json': JSON.stringify({ license: 'MIT' }) })
    expect(runTsx(good.root, gatePath('licence')).status).toBe(0)
  }, 60_000)
})
