/** The last view: the workspace exists, but some of its setup did not come out. */
import type { ReactNode } from 'react'
import type { SetupNote } from '../create.ts'
import { DialogFooter } from '../footer.tsx'
import type { Translate } from '../locales.ts'
import css from './screens.module.css'

/** The props of the done view. */
export interface DoneScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The setup steps that did not come out. */
  readonly notes: readonly SetupNote[]
  /** Open the workspace. */
  readonly onOpen: () => void
}

/** The copy key of each note. */
const NOTE_KEY = { 'defaults': 'done.defaults', 'network': 'done.network', 'full-access-later': 'done.fullAccess' } as const satisfies Record<SetupNote, string>

/**
 * The done view.
 * @param props - the notes and what opens the workspace.
 * @returns the view.
 */
export function DoneScreen({ t, notes, onOpen }: DoneScreenProps): ReactNode {
  return (
    <div className={css.screen}>
      <h3 className={css.question} data-modal-autofocus tabIndex={-1}>{t('done.title')}</h3>
      {notes.map(note => <p key={note} className={css.failure} role="alert">{t(NOTE_KEY[note])}</p>)}
      <DialogFooter primary={{ label: t('done.open'), onClick: onOpen }} />
    </div>
  )
}
