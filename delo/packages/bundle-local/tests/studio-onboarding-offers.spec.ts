/** What the studio bundle's onboarding row offers: the chat import is offered as a bundle, never mounted as a row. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const CHAT_IMPORT = '@deepseek-ai/dsh-deepseek-chat-import'
const patch = yaml.load(readFileSync(fileURLToPath(new URL('../../bundle-studio/cordis.patch.yml', import.meta.url)), 'utf8')) as Array<{ insert?: Array<{ id: string; name: string; config?: { plugins?: string[]; optionalRows?: string[] } }> }>
const rows = patch.flatMap(entry => entry.insert ?? [])

describe('the studio bundle offers the DeepSeek website chat import', () => {
  it('names the package on the onboarding row, so the guide turns it on through the plugin manager', () => {
    expect(rows.find(row => row.id === 'delo-onboarding')?.config?.plugins).toContain(CHAT_IMPORT)
  })

  it('does not insert a row for it, which would mount it twice once the plugin manager turns it on', () => {
    expect(rows.some(row => row.name === CHAT_IMPORT)).toBe(false)
    expect(rows.find(row => row.id === 'delo-onboarding')?.config?.optionalRows).not.toContain('deepseek-chat-import')
  })
})
