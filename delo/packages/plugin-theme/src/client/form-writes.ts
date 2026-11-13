/**
 * The read and write state every settings control of this package shares: the
 * form's current snapshot, whether it accepts writes, and whether the last
 * write failed.
 * @module @delo/plugin-theme/client/form-writes
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** What {@link useFormWrites} returns. */
export interface FormWrites<T> {
  /** The form's current snapshot. */
  readonly snapshot: ConfigFormSnapshot<T>
  /** Whether the Host document refuses writes, so every control is locked. */
  readonly disabled: boolean
  /** Whether the last tracked write was refused or could not be carried; cleared when the next one starts. */
  readonly failed: boolean
  /**
   * Follow one write: clear the failure, then set it when the write resolves `false` or rejects.
   * @param write - the pending write.
   */
  readonly track: (write: Promise<boolean>) => void
  /**
   * Write one field of the form and follow the write.
   * @param field - the field.
   * @param value - its new value.
   */
  readonly save: (field: keyof T & string, value: unknown) => void
}

/**
 * Follow a settings form and its writes.
 * @param form - the form.
 * @returns the snapshot, the lock and the failure state, with the write helpers.
 */
export function useFormWrites<T>(form: ConfigForm<T>): FormWrites<T> {
  // A stable subscribe function: a new one per render would resubscribe on every render, including after the plugin is disposed.
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const snapshot = useSyncExternalStore(subscribe, () => form.getSnapshot())
  const [failed, setFailed] = useState(false)
  const track = (write: Promise<boolean>): void => {
    setFailed(false)
    void write.then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const save = (field: keyof T & string, value: unknown): void => { track(form.set(field, value)) }
  return { snapshot, disabled: !snapshot.writable, failed, track, save }
}
