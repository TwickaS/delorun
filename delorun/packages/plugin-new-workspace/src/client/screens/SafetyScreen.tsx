/** Screen 5: what chats may do in the workspace, and the internet its commands get. */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { DialogFooter } from '../footer.tsx'
import { safetyProblem, type NetworkAccess, type Permission, type Problem, type SafetyChoice } from '../flow.ts'
import { MAX_HOSTS } from '../hosts.ts'
import type { Translate } from '../locales.ts'
import { problemText } from '../problems.ts'
import { ChatsBlock } from './ChatsBlock.tsx'
import css from './screens.module.css'

/** The props of the safety screen. */
export interface SafetyScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The choices so far. */
  readonly safety: SafetyChoice
  /** Whether a request is running. */
  readonly busy: boolean
  /** The reason the last attempt failed. */
  readonly problem: Problem | undefined
  /**
   * Change a choice.
   * @param change - the fields to change.
   */
  readonly onChange: (change: Partial<SafetyChoice>) => void
  /** Make the workspace. */
  readonly onCreate: () => void
  /** Go back to the model screen. */
  readonly onBack: () => void
}

/** The permission choices, in order. Read only is not offered: a chat switches to it from the permission menu. */
const PERMISSIONS: readonly Permission[] = ['files', 'full']

/** The network choices, in order. */
const ACCESSES: readonly NetworkAccess[] = ['open', 'allowlist', 'off']

/**
 * The safety screen.
 * @param props - the choices and what changes them.
 * @returns the screen.
 */
export function SafetyScreen({ t, safety, busy, problem, onChange, onCreate, onBack }: SafetyScreenProps): ReactNode {
  const permissionName = useId()
  const accessName = useId()
  const hostsId = useId()
  const hostsError = useId()
  const hosts = safetyProblem(safety)
  const showHosts = safety.access === 'allowlist'
  const typed = safety.hosts.trim() !== ''
  return (
    <div className={css.screen}>
      <h3 className={css.question} data-modal-autofocus tabIndex={-1}>{t('safety.title')}</h3>
      <fieldset className={css.choices}>
        <legend className={css.label}>{t('safety.permission')}</legend>
        {PERMISSIONS.map(permission => (
          <label key={permission} className={css.choice}>
            <input type="radio" name={permissionName} value={permission} checked={safety.permission === permission} disabled={busy}
              onChange={() => { onChange({ permission }) }} />
            <span className={css.choiceText}>
              <span className={css.choiceTitle}>{t(`safety.${permission}.title`)}</span>
              <span className={css.hint}>{t(`safety.${permission}.body`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className={css.choices}>
        <legend className={css.label}>{t('safety.network')}</legend>
        {ACCESSES.map(access => (
          <label key={access} className={css.choice}>
            <input type="radio" name={accessName} value={access} checked={safety.access === access} disabled={busy}
              onChange={() => { onChange({ access }) }} />
            <span className={css.choiceText}>
              <span className={css.choiceTitle}>{t(`safety.network.${access}`)}</span>
              <span className={css.hint}>{t(`safety.network.${access}.body`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {showHosts && (
        <div className={css.field}>
          <label htmlFor={hostsId} className={css.label}>{t('safety.hosts')}</label>
          <textarea id={hostsId} className={css.textarea} value={safety.hosts} placeholder={t('safety.hostsPlaceholder')} rows={4}
            autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={typed && hosts !== undefined}
            aria-describedby={hosts === undefined ? undefined : hostsError}
            onChange={(event) => { onChange({ hosts: event.target.value }) }} />
          {hosts?.kind === 'invalid' && <p id={hostsError} className={css.failure} role="alert">{t('safety.hostsInvalid', { host: hosts.host })}</p>}
          {hosts?.kind === 'too-many' && <p id={hostsError} className={css.failure} role="alert">{t('safety.hostsTooMany', { n: MAX_HOSTS })}</p>}
          {hosts?.kind === 'empty' && <p id={hostsError} className={css.hint}>{t('safety.hostsEmpty')}</p>}
        </div>
      )}
      <p className={css.hint}>{t('safety.override')}</p>
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <ChatsBlock t={t} />
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        primary={{ label: t('create'), onClick: onCreate, disabled: busy || hosts !== undefined }} />
    </div>
  )
}
