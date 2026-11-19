import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unexportedPackages, unwordedPackages } from '../../src/checks/gates/plugin-sentences.ts'

function tree(files: Record<string, string>, test: { onTestFinished: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-sentences-'))
  test.onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  return root
}

const manifest = (name: string, extra: object = {}, exports: object = { './locale/*.json': './locale/*.json' }): string => JSON.stringify({ name, exports, delorun: { state: 'shipped', ...extra } })
const patch = (...names: string[]): string => `- insert:\n${names.map((name) => `    - id: row-${name}\n      name: '@delorun/${name}'\n`).join('')}`
const words = JSON.stringify({ meta: { title: 'A title', description: 'A sentence.' } })

const BASE = {
  'delorun/packages/bundle-local/cordis.patch.yml': patch('plugin-a'),
  'delorun/packages/bundle-studio/cordis.patch.yml': '- insert: []\n',
  'delorun/packages/bundle-headless/cordis.patch.yml': '- insert: []\n',
  'delorun/packages/bundle-local/package.json': manifest('@delorun/bundle-local'),
  'delorun/packages/plugin-a/package.json': manifest('@delorun/plugin-a'),
}

describe('gates:plugin-sentences', () => {
  it('passes when every listed package has a title and a sentence', (test) => {
    const root = tree({ ...BASE, 'delorun/packages/plugin-a/locale/en.json': words }, test)
    expect(unwordedPackages(root)).toEqual([])
  })

  it('names a listed package whose locale file has no sentence', (test) => {
    const root = tree({ ...BASE, 'delorun/packages/plugin-a/locale/en.json': JSON.stringify({ meta: { title: 'A title' } }) }, test)
    expect(unwordedPackages(root)).toEqual(['@delorun/plugin-a'])
  })

  it('names a listed package with no locale file, and a pack the patches do not name', (test) => {
    const root = tree({ ...BASE, 'delorun/packages/bundle-x/package.json': manifest('@delorun/bundle-x', { pack: true }) }, test)
    expect(unwordedPackages(root)).toEqual(['@delorun/plugin-a', '@delorun/bundle-x'])
  })

  it('leaves out a package no patch row and no pack names', (test) => {
    const root = tree({ ...BASE, 'delorun/packages/plugin-a/locale/en.json': words, 'delorun/packages/library/package.json': manifest('@delorun/library') }, test)
    expect(unwordedPackages(root)).toEqual([])
  })

  it('names a listed package whose exports do not reach its locale files', (test) => {
    const root = tree({ ...BASE, 'delorun/packages/plugin-a/package.json': manifest('@delorun/plugin-a', {}, { '.': './src/index.ts' }), 'delorun/packages/plugin-a/locale/en.json': words }, test)
    expect(unexportedPackages(root)).toEqual(['@delorun/plugin-a'])
    expect(unwordedPackages(root)).toEqual([])
  })
})
