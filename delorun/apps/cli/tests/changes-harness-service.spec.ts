/**
 * The home process gives the Host it boots the running runtime's harness as `changesHarness`, for as long as the Host's
 * root context lives.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ChangesHarnessHost, HarnessContext } from '@delorun/changes'
import { describe, expect, it } from 'vitest'
import { provideChangesHarness } from '../src/changes/harness-service.ts'

/**
 * @param root - a root context.
 * @returns its `changesHarness` service, if provided.
 */
function serviceOf(root: Context): ChangesHarnessHost | undefined {
  return (root as Context & { get(name: 'changesHarness'): ChangesHarnessHost | undefined }).get('changesHarness')
}

describe('the changesHarness service', () => {
  it('gives the running runtime\'s harness, or none outside the runtime store', () => {
    const harness: HarnessContext = { home: '/nowhere', runtime: '1.2.3', signed: () => Promise.reject(new Error('unused')) }
    const root = new Context()
    provideChangesHarness(root, harness)
    expect(serviceOf(root)?.context()).toBe(harness)
    const source = new Context()
    provideChangesHarness(source, undefined)
    expect(serviceOf(source)?.context()).toBeUndefined()
  })
})
