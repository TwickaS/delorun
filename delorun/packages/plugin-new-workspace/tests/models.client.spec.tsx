// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseHosts } from '../src/client/hosts.ts'
import { modelToStore, selectionOf, viewOfCatalog, type RemoteCatalog } from '../src/client/models.ts'
import { CATALOG } from './fixtures.client.ts'

const REMOTE: RemoteCatalog = {
  default: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [
      { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      { id: 'plain', name: 'Plain' },
    ] },
  ],
}

describe('the catalogue view', () => {
  it('lists every model with its thinking levels and keeps the home\'s default', () => {
    const view = viewOfCatalog(REMOTE)
    expect(view.default).toEqual({ provider: 'deepseek', model: 'pro', reasoningEffort: 'high' })
    expect(view.options.map(option => [option.provider, option.id, option.efforts.map(effort => effort.id), option.defaultEffort])).toEqual([
      ['deepseek', 'pro', ['low', 'high'], 'low'],
      ['deepseek', 'plain', [], undefined],
    ])
  })

  it('lists the home\'s default model first when no provider group holds it', () => {
    const view = viewOfCatalog({ ...REMOTE, default: { provider: 'gone', model: 'old' } })
    expect(view.options[0]).toMatchObject({ provider: 'gone', id: 'old', name: 'old', efforts: [] })
    expect(view.options).toHaveLength(3)
  })
})

describe('what a pick stands for', () => {
  it('is the home\'s default model and level when nothing was picked', () => {
    expect(selectionOf(CATALOG, undefined)).toMatchObject({ option: { id: 'deepseek-pro' }, effort: 'high' })
    expect(modelToStore(CATALOG, undefined)).toEqual({ provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' })
  })

  it('takes the picked model\'s own default level unless one was picked', () => {
    expect(modelToStore(CATALOG, { provider: 'deepseek', model: 'deepseek-flash', effort: undefined })).toEqual({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' })
    expect(modelToStore(CATALOG, { provider: 'deepseek', model: 'deepseek-flash', effort: 'on' })).toEqual({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'on' })
  })

  it('stores a model without levels with none, and nothing without a catalogue or for an unknown model', () => {
    expect(modelToStore(CATALOG, { provider: 'other', model: 'plain', effort: undefined })).toEqual({ provider: 'other', model: 'plain' })
    expect(modelToStore(undefined, undefined)).toBeUndefined()
    expect(modelToStore(CATALOG, { provider: 'x', model: 'y', effort: undefined })).toBeUndefined()
  })
})

describe('the allowlist text', () => {
  it('trims, lower-cases, removes duplicates and sorts', () => {
    expect(parseHosts(' PyPI.org \n\nregistry.npmjs.org\npypi.org\n*.GitHub.com')).toEqual({ hosts: ['*.github.com', 'pypi.org', 'registry.npmjs.org'] })
  })

  it('takes a port and refuses single names, schemes, paths, bad ports and wildcards over a top-level domain', () => {
    expect(parseHosts('github.com:22')).toEqual({ hosts: ['github.com:22'] })
    for (const bad of ['localhost', 'https://a.example', 'a.example/x', 'a.example:0', 'a.example:70000', '*.com', '-a.example', 'a b.example', 'user@a.example']) {
      expect(parseHosts(bad), bad).toEqual({ problem: { kind: 'invalid', host: bad } })
    }
  })

  it('refuses an empty list and one over the most the Host keeps', () => {
    expect(parseHosts(' \n ')).toEqual({ problem: { kind: 'empty' } })
    expect(parseHosts(Array.from({ length: 201 }, (_, index) => `h${index}.example`).join('\n'))).toEqual({ problem: { kind: 'too-many' } })
  })
})
