/**
 * The update's release notes as the person reads them: up to five one-line highlights across every version the update
 * skipped, then "Read more", which opens the full change log of those versions in a sheet (full screen on a phone, with
 * Back). The notes arrive with the update's state, so the sheet works offline.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UpdateNotesView } from '../wire.ts'
import css from './UpdatePanel.module.css'
import type { T } from './parts.tsx'

/** The most highlights the card shows. */
export const MAX_CARD_HIGHLIGHTS = 5

/**
 * The highlights the card shows: each version's own, newest version first, up to {@link MAX_CARD_HIGHLIGHTS}.
 * @param notes - the update's notes.
 * @returns the highlight lines.
 */
export function cardHighlights(notes: UpdateNotesView): readonly string[] {
  return notes.versions.flatMap(version => version.highlights).slice(0, MAX_CARD_HIGHLIGHTS)
}

/**
 * The highlights and the Read more button of an outcome card.
 * @param props - the notes and the dictionary.
 * @returns the block, or nothing when the notes hold no highlight.
 */
export function NotesHighlights({ notes, t }: { readonly notes: UpdateNotesView | undefined, readonly t: T }) {
  const [open, setOpen] = useState(false)
  if (notes === undefined) return null
  const lines = cardHighlights(notes)
  if (lines.length === 0) return null
  return <div className={css.notes} data-update-notes>
    <ul className={css.highlights}>{lines.map(line => <li key={line}>{line}</li>)}</ul>
    <div><Button variant="outline" size="sm" onClick={() => { setOpen(true) }}>{t('notes.more')}</Button></div>
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('notes.title')} closeLabel={t('notes.back')} className={String(css.notesSheet)}
      footer={<Button variant="outline" data-modal-autofocus onClick={() => { setOpen(false) }}>{t('notes.back')}</Button>}>
      <div className={css.notesBody} data-update-notes-sheet>
        {notes.versions.map(version => <section key={version.version} aria-label={version.version}>
          <h3 className={css.heading}>{version.date === undefined ? version.version : t('notes.version', { version: version.version, date: version.date })}</h3>
          {version.areas.map(area => <div key={area.area}>
            <h4 className={css.areaHeading}>{area.area}</h4>
            <ul className={css.highlights}>{area.items.map(item => <li key={`${item.section}:${item.text}`}>{item.text}</li>)}</ul>
          </div>)}
        </section>)}
        {notes.truncated ? <p className={css.meta}>{t('notes.truncated')}</p> : null}
      </div>
    </Modal>
  </div>
}
