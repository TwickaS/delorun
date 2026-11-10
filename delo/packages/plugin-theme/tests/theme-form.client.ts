/** The theme row's settings form as a spec drives it: writes the Host accepts update the stored value, as a Host acceptance does. */
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { DEFAULT_SETTINGS, type ThemeSettings } from '../src/config.ts'

/** The settings of a studio with Delo's look on. */
export const STUDIO_ON: ThemeSettings = { ...DEFAULT_SETTINGS, studioAdditions: true }

/** A form handle with a `writes` log and a switch for refusing writes. */
export interface ThemeFormHandle extends StubConfigForm<ThemeSettings> {
  /** Every `[field, value]` written, in order. */
  readonly writes: Array<[string, unknown]>
  /** How the Host answers the next writes: `true` accepts, `false` refuses, `'throw'` rejects. */
  answer: boolean | 'throw'
}

/**
 * Build the form.
 * @param initial - the settings the Host holds, or `undefined` for a form still loading.
 * @param status - the form's sync state once `initial` is given.
 * @returns the handle.
 */
export function themeForm(initial: ThemeSettings | undefined, status: 'ready' | 'unavailable' = 'ready'): ThemeFormHandle {
  const handle = stubConfigForm<ThemeSettings>()
  const writes: Array<[string, unknown]> = []
  const form: ThemeFormHandle = Object.assign(handle, { writes, answer: true as boolean | 'throw' })
  form.set.mockImplementation((field: string, value: unknown) => {
    writes.push([field, value])
    if (form.answer === 'throw') return Promise.reject(new Error('transport'))
    if (form.answer) form.publish({ value: { ...(form.scope.getSnapshot().value ?? DEFAULT_SETTINGS), [field]: value } })
    return Promise.resolve(form.answer)
  })
  if (initial !== undefined || status === 'unavailable') form.publish({ status, value: initial, writable: true })
  return form
}
