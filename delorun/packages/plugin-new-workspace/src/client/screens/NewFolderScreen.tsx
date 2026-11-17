/** Screen 2b: a new folder. Its name, where it goes, and whether Git starts in it. */
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { isFolderName } from '../../clone-address.ts'
import { DialogFooter } from '../footer.tsx'
import type { Choice, Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { displayPath, joinPath } from '../paths.ts'
import { problemText } from '../problems.ts'
import css from './screens.module.css'

/** The props of the new-folder screen. */
export interface NewFolderScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The home folder, which paths show as `~`. */
  readonly home: string
  /** What is chosen so far. */
  readonly choice: Extract<Choice, { kind: 'new' }>
  /** Whether a request is running. */
  readonly busy: boolean
  /** The reason the last attempt failed. */
  readonly problem: Problem | undefined
  /**
   * Change a field.
   * @param change - the fields to change.
   */
  readonly onEdit: (change: { readonly name?: string, readonly git?: boolean }) => void
  /** Open the folder browser to pick where the folder goes. */
  readonly onChangePlace: () => void
  /** Make the folder. */
  readonly onSubmit: () => void
  /** Go back to the first screen. */
  readonly onBack: () => void
}

/**
 * The new-folder screen.
 * @param props - the choice and what changes it.
 * @returns the screen.
 */
export function NewFolderScreen({ t, home, choice, busy, problem, onEdit, onChangePlace, onSubmit, onBack }: NewFolderScreenProps): ReactNode {
  const nameId = useId()
  const errorId = useId()
  const name = choice.name
  const filled = name !== ''
  const valid = filled && isFolderName(name)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (valid && !busy) onSubmit()
  }
  return (
    <form className={css.screen} onSubmit={submit} noValidate>
      <div className={css.field}>
        <label htmlFor={nameId} className={css.label}>{t('new.name')}</label>
        <Input className={css.input as string} id={nameId} value={name} placeholder={t('new.namePlaceholder')} autoComplete="off" spellCheck={false} disabled={busy}
          aria-invalid={filled && !valid} aria-describedby={filled && !valid ? errorId : undefined} data-modal-autofocus
          onChange={(event) => { onEdit({ name: event.target.value }) }} />
        {filled && !valid && <p id={errorId} className={css.failure} role="alert">{t('new.nameInvalid')}</p>}
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('new.goesIn')}</span>
        <div className={css.row}>
          <span className={css.path}>{displayPath(choice.parent, home)}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={onChangePlace}>{t('new.change')}</Button>
        </div>
        {valid && <p className={css.hint}>{t('new.willBe', { path: displayPath(joinPath(choice.parent, name), home) })}</p>}
      </div>
      <div className={css.field}>
        <Checkbox checked={choice.git} disabled={busy} label={t('new.git')} onChange={(git) => { onEdit({ git }) }} />
        <p className={css.hint}>{t('new.gitHelp')}</p>
      </div>
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        primary={{ label: t('create'), onClick: onSubmit, disabled: busy || !valid }} />
    </form>
  )
}
