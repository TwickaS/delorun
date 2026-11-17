/**
 * A PIN or passcode typed twice: two masked fields that the browser does not remember, with one help line and one error
 * line. The typed text lives in the caller's state; this component stores nothing.
 * @module @delorun/brand/components/SecretPair
 */
import type { ReactNode } from 'react'
import { TextField } from './TextField.tsx'
import css from './SecretPair.module.css'

/** The props of {@link SecretPair}. */
export interface SecretPairProps {
  /** The first field's localized label. */
  readonly label: string
  /** The second field's localized label. */
  readonly confirmLabel: string
  /** One localized sentence on what the secret may be, shown while there is no error. */
  readonly help?: string | undefined
  /** A localized error, announced under the second field. */
  readonly error?: string | undefined
  /** The first entry. */
  readonly secret: string
  /** The second entry. */
  readonly again: string
  /** Called with the first entry as it changes. */
  readonly onSecret: (value: string) => void
  /** Called with the second entry as it changes. */
  readonly onAgain: (value: string) => void
  /** Whether both fields are disabled, as while a request is sent. */
  readonly disabled?: boolean | undefined
}

/**
 * Render the two fields.
 * @param props - see {@link SecretPairProps}.
 * @returns the fields.
 */
export function SecretPair({ label, confirmLabel, help, error, secret, again, onSecret, onAgain, disabled }: SecretPairProps): ReactNode {
  const common = { type: 'password', inputMode: 'text', autoComplete: 'new-password', autoCapitalize: 'off', spellCheck: false, disabled } as const
  return (
    <div className={css.pair} data-secret-pair>
      <TextField {...common} label={label} help={help} value={secret} onChange={(event) => { onSecret(event.target.value) }} />
      <TextField {...common} label={confirmLabel} error={error} value={again} onChange={(event) => { onAgain(event.target.value) }} />
    </div>
  )
}
