import { describe, expect, it } from 'vitest'
import { defaultKeyVariables, routeFields } from '../src/setup-transfer/policy.ts'

describe('defaultKeyVariables', () => {
  it('lists the variable the pi-ai catalog gives the provider', () => {
    expect(defaultKeyVariables('google')).toContain('GEMINI_API_KEY')
    expect(defaultKeyVariables('google')).not.toContain('GITHUB_TOKEN')
    expect(defaultKeyVariables('deepseek')).toEqual(['DEEPSEEK_API_KEY'])
  })

  it('allows none for a provider the catalog does not know', () => {
    expect(defaultKeyVariables('my-own-endpoint')).toEqual([])
  })

  it('reads the key field of a carried row', () => {
    const fields = routeFields({ name: 'google', config: { apiKeyEnv: 'GITHUB_TOKEN' } } as never)
    expect(fields.some(field => field.kind === 'key' && field.value === 'GITHUB_TOKEN')).toBe(true)
  })
})
