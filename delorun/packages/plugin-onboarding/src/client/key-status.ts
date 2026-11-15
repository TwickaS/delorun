/**
 * The one place the key-test result lives. The guide, the empty-chat banner and Settings → Models all read the
 * answer of the free model-list test through this store, so a key reads the same on every screen. It holds route ids and
 * results only, never a key or any part of one, and keeps nothing across a page load: the test runs again.
 * @module @delorun/plugin-onboarding/client/key-status
 */
import type { ModelKeyStatus, ModelKeyStatusSnapshot } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { KeyResult, KeyTestAnswer } from '../wire.ts'

/** The results that mean a stored key was tried and did not pass. */
const DID_NOT_PASS: ReadonlySet<KeyResult> = new Set(['rejected', 'failed'])

/**
 * @param result - one route's test result.
 * @returns true when a key is stored and did not pass its test.
 */
export function didNotPass(result: KeyResult): boolean {
  return DID_NOT_PASS.has(result)
}

/** The shared store: the service Settings reads, plus the refresh the guide and the banner call. */
export interface KeyStatusStore extends ModelKeyStatus {
  /**
   * Run the test; a run already in flight is joined.
   * @returns the answer, or undefined when the harness could not be asked.
   */
  refresh(): Promise<KeyTestAnswer | undefined>
  /** @returns the latest answer, or undefined before the first one. */
  answer(): KeyTestAnswer | undefined
}

/**
 * Create the store.
 * @param ask - the harness's key test.
 * @param copy - the translated words the Models page shows.
 * @returns the store.
 */
export function createKeyStatus(ask: () => Promise<KeyTestAnswer | undefined>, copy: () => ReturnType<ModelKeyStatus['copy']>): KeyStatusStore {
  const listeners = new Set<() => void>()
  let latest: KeyTestAnswer | undefined
  let snapshot: ModelKeyStatusSnapshot = { failed: new Set(), testing: false }
  let running: Promise<KeyTestAnswer | undefined> | undefined
  const publish = (testing: boolean): void => {
    const failed = new Set(latest?.providers.filter(each => didNotPass(each.result)).map(each => each.provider))
    snapshot = { failed, testing }
    for (const listener of listeners) listener()
  }
  const refresh = (): Promise<KeyTestAnswer | undefined> => {
    if (running !== undefined) return running
    publish(true)
    running = ask().then((answer) => {
      if (answer !== undefined) latest = answer
      return answer
    }).finally(() => {
      running = undefined
      publish(false)
    })
    return running
  }
  return {
    refresh,
    answer: () => latest,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    test: () => { void refresh() },
    copy,
  }
}
