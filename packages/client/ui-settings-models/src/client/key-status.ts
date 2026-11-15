/**
 * The optional `modelKeyStatus` service: a product shell supplies which model routes hold a key that failed its free
 * model-list test, so the Models page marks them and offers a re-test. Without the service the page shows only
 * whether a credential is configured.
 * @module dsh-client-ui-settings-models/client/key-status
 */
import { useSyncExternalStore } from 'react'

/** What the Models page reads of the key tests. */
export interface ModelKeyStatusSnapshot {
  /** Route ids whose stored key did not pass its test. */
  readonly failed: ReadonlySet<string>
  /** True while a test runs. */
  readonly testing: boolean
}

/** The shell's key-test service. */
export interface ModelKeyStatus {
  /** @returns the current snapshot; the same object until something changes. */
  getSnapshot(): ModelKeyStatusSnapshot
  /**
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void
  /** Run the test now; the snapshot reports the outcome. */
  test(): void
  /** @returns the service's own copy for the failed marker and the test button, already translated. */
  copy(): { readonly failed: string; readonly test: string; readonly testing: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Supplied by a product shell; absent in the stock harness. */
    modelKeyStatus?: ModelKeyStatus
  }
}

const NONE: ModelKeyStatusSnapshot = { failed: new Set(), testing: false }
const IDLE = { subscribe: (): (() => void) => () => undefined, getSnapshot: (): ModelKeyStatusSnapshot => NONE }

/**
 * Subscribe to the service, or to an empty status when there is none.
 * @param status - the service, when the shell supplies one.
 * @returns the current snapshot.
 */
export function useModelKeyStatus(status: ModelKeyStatus | undefined): ModelKeyStatusSnapshot {
  const source = status ?? IDLE
  return useSyncExternalStore(source.subscribe, source.getSnapshot)
}
