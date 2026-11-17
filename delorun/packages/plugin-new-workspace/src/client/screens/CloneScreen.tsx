/** Screen 2c: clone from Git. The address, an optional branch, where it goes and the folder's name. */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { hasUrlCredentials, isBranchName, isCloneAddress, isFolderName, suggestedName } from '../../clone-address.ts'
import { DialogFooter } from '../footer.tsx'
import type { Choice, Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { displayPath, joinPath } from '../paths.ts'
import { problemText } from '../problems.ts'
import css from './screens.module.css'

/** The fields of a clone choice the person edits. */
export type CloneEdit = Partial<{ url: string, branch: string, name: string }>

/** The props of the clone screen. */
export interface CloneScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The home folder, which paths show as `~`. */
  readonly home: string
  /** What is chosen so far. */
  readonly choice: Extract<Choice, { kind: 'clone' }>
  /** Whether the clone is starting or running, which holds every field. */
  readonly busy: boolean
  /** The reason the clone was refused or failed. */
  readonly problem: Problem | undefined
  /**
   * Change a field. The folder name follows the address until the person edits the name.
   * @param change - the fields to change.
   */
  readonly onEdit: (change: CloneEdit) => void
  /** Open the folder browser to pick where the clone goes. */
  readonly onChangePlace: () => void
  /** Start the clone. */
  readonly onSubmit: () => void
  /** Go back to the first screen. */
  readonly onBack: () => void
}

/**
 * Whether an address is one the Host takes without a user name or password.
 * @param url - the address as typed.
 * @returns true when the clone may start from it.
 */
function addressUsable(url: string): boolean {
  return isCloneAddress(url) && !hasUrlCredentials(url)
}

/**
 * The clone screen.
 * @param props - the choice and what changes it.
 * @returns the screen.
 */
export function CloneScreen({ t, home, choice, busy, problem, onEdit, onChangePlace, onSubmit, onBack }: CloneScreenProps): ReactNode {
  const addressId = useId()
  const branchId = useId()
  const nameId = useId()
  const { url, branch, name } = choice
  const addressFilled = url !== ''
  const addressOk = isCloneAddress(url)
  const credentials = addressOk && hasUrlCredentials(url)
  const branchOk = branch === '' || isBranchName(branch)
  const nameFilled = name !== ''
  const nameOk = nameFilled && isFolderName(name)
  const ready = addressUsable(url) && branchOk && nameOk
  const changeAddress = (next: string): void => {
    // The name follows the address until the person types a different one.
    const follows = name === suggestedName(url)
    onEdit(follows ? { url: next, name: suggestedName(next) } : { url: next })
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (ready && !busy) onSubmit()
  }
  return (
    <form className={css.screen} onSubmit={submit} noValidate>
      <div className={css.field}>
        <label htmlFor={addressId} className={css.label}>{t('clone.address')}</label>
        <Input className={css.input as string} id={addressId} value={url} placeholder={t('clone.addressPlaceholder')} autoComplete="off" spellCheck={false} disabled={busy}
          aria-invalid={addressFilled && !addressUsable(url)} data-modal-autofocus
          onChange={(event) => { changeAddress(event.target.value) }} />
        {addressFilled && !addressOk && <p className={css.failure} role="alert">{t('clone.addressInvalid')}</p>}
        {credentials && <p className={css.failure} role="alert">{t('clone.credentials')}</p>}
      </div>
      <div className={css.field}>
        <label htmlFor={branchId} className={css.label}>{t('clone.branch')}</label>
        <Input className={css.input as string} id={branchId} value={branch} placeholder={t('clone.branchPlaceholder')} autoComplete="off" spellCheck={false} disabled={busy}
          aria-invalid={!branchOk} onChange={(event) => { onEdit({ branch: event.target.value }) }} />
        {!branchOk && <p className={css.failure} role="alert">{t('clone.branchInvalid')}</p>}
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('clone.goesIn')}</span>
        <div className={css.row}>
          <span className={css.path}>{displayPath(choice.parent, home)}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={onChangePlace}>{t('clone.change')}</Button>
        </div>
      </div>
      <div className={css.field}>
        <label htmlFor={nameId} className={css.label}>{t('clone.folderName')}</label>
        <Input className={css.input as string} id={nameId} value={name} autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={nameFilled && !nameOk}
          onChange={(event) => { onEdit({ name: event.target.value }) }} />
        {nameFilled && !nameOk && <p className={css.failure} role="alert">{t('clone.nameInvalid')}</p>}
        {nameOk && <p className={css.hint}>{t('clone.willBe', { path: displayPath(joinPath(choice.parent, name), home) })}</p>}
      </div>
      <p className={css.hint}>{t('clone.private')}</p>
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        primary={{ label: t('clone.start'), onClick: onSubmit, disabled: busy || !ready }} />
    </form>
  )
}
