/** What the studio bundle's onboarding row offers: the chat import is offered as a bundle, never mounted as a row. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const CHAT_IMPORT = '@deepseek-ai/dsh-deepseek-chat-import'
const patch = yaml.load(readFileSync(fileURLToPath(new URL('../../bundle-studio/cordis.patch.yml', import.meta.url)), 'utf8')) as Array<{ insert?: Array<{ id: string; name: string; config?: { plugins?: string[]; optionalRows?: string[]; hiddenProviders?: string[] } }> }>
const rows = patch.flatMap(entry => entry.insert ?? [])

describe('the studio bundle offers the DeepSeek website chat import', () => {
  it('names the package on the onboarding row, so the guide turns it on through the plugin manager', () => {
    expect(rows.find(row => row.id === 'delorun-onboarding')?.config?.plugins).toContain(CHAT_IMPORT)
  })

  it('does not insert a row for it, which would mount it twice once the plugin manager turns it on', () => {
    expect(rows.some(row => row.name === CHAT_IMPORT)).toBe(false)
    expect(rows.find(row => row.id === 'delorun-onboarding')?.config?.optionalRows).not.toContain('deepseek-chat-import')
  })
})

describe('the studio bundle keeps the DeepSeek account route out of the guide', () => {
  it('hides the account model route from the guide\'s provider list instead of disabling its row', () => {
    expect(rows.find(row => row.id === 'delorun-onboarding')?.config?.hiddenProviders).toEqual(['deepseek-account'])
  })
})

const OPTIONAL_BUNDLES = ['browser', 'code-intelligence', 'agent-hooks', 'webhooks', 'external-agents', 'computer-use-driver'].map(name => `@delorun/bundle-${name}`)

describe('the studio bundle offers the optional bundles as packs (A405)', () => {
  it('names each bundle on the onboarding row, so the guide offers it and the install queue downloads it', () => {
    expect(rows.find(row => row.id === 'delorun-onboarding')?.config?.plugins).toEqual(expect.arrayContaining(OPTIONAL_BUNDLES))
  })

  it('mounts none of them as a row, so each stays off until the person adds it', () => {
    for (const name of OPTIONAL_BUNDLES) expect(rows.some(row => row.name === name), name).toBe(false)
  })
})

// The row's config is validated against the plugin's own schema in plugin-onboarding's shipped-config spec; importing the
// plugin here would make bundle-local's build depend on a package that depends on it.
