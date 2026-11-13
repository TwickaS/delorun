/**
 * Setup's import section passes on a failure of the plan that is not a
 * refusal, rather than showing it as a reason the home cannot be imported.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETUP_DEFAULTS } from '@delo/contract-setup-answers'
import { importSection } from '../../src/import-home/section.ts'
import { stepIO } from '../../src/setup/steps.ts'
import { scriptedPrompter } from '../setup/support.ts'

vi.mock('@delo/archive/dsh-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delo/archive/dsh-import')>()
  return { ...actual, planDshHomeImport: () => Promise.reject(new TypeError('an unexpected failure')) }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('setup\'s import section', () => {
  it('passes on a failure of the plan that is not a refusal', async () => {
    const section = importSection({ deloBundles: [] })
    const environment = { env: { HOME: '/' }, home: '/nowhere', profile: 'default', profileExists: false, profileNameTaken: () => false, checkKey: async () => ({ ok: true as const }), checkEnvironmentKey: false, portIsFree: async () => true, hasSavedKey: () => false }
    await expect(section.ask(stepIO(scriptedPrompter([], { screen: [], asked: [] }), true), { phase: 'main', answers: SETUP_DEFAULTS, secret: undefined }, environment)).rejects.toThrow('an unexpected failure')
  })
})
