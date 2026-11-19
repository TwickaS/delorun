/**
 * The note at the top of the Changes section on a paired device: what a phone takes without asking and what it confirms
 * with Face ID or its PIN each time, never with an unlock window. The computer's page shows no note.
 */
import type { AccessView } from '../wire.ts'
import css from './ChangesSection.module.css'
import type { T } from './parts.tsx'

/**
 * Render the note.
 * @param props - who reads the page, and the dictionary.
 * @returns the note, or nothing at the computer.
 */
export function AccessNote({ access, t }: { readonly access: AccessView, readonly t: T }) {
  if (access.actor === 'computer') return null
  return <div className={css.remote} role="note" data-delorun-changes-remote={access.actor}>
    <p className={css.remoteTitle}>{t('access.device.title')}</p>
    <p className={css.meta}>{t('access.device.body')}</p>
  </div>
}
