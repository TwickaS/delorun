/**
 * The Browser choice: whether agents may use a web browser, as one group of radios, with whether Browser is ready
 * under it while the isolated browser is chosen. The component is presentational: it reads nothing and writes nothing,
 * and the caller holds the choice, reads the readiness and decides what a choice does.
 * @module @delorun/browser-setup/client/BrowserChoices
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { BrowserReadiness, RequirementFix } from '../index.ts'
import type { BrowserSetupLocaleKey } from './locales.ts'
import css from './BrowserChoices.module.css'

/** What a person can choose: agents use the isolated browser, or none. */
export type BrowserChoice = 'isolated' | 'none'

/** The rows the group draws. */
const CHOICES = ['isolated', 'none'] as const

/**
 * The caller's bound translate function, whose dictionaries include this package's (`@delorun/browser-setup/locales`).
 * @param key - one of the choice's keys.
 * @param params - the values of the key's placeholders.
 * @returns the words in the studio's language.
 */
export type BrowserTranslate = (key: BrowserSetupLocaleKey, params?: Readonly<Record<string, string>>) => string

/** The props of {@link BrowserChoices}. */
export interface BrowserChoicesProps {
  /** The caller's translate function. */
  readonly t: BrowserTranslate
  /** The question above the choices, where the caller's differs from the dictionary's home-wide one. */
  readonly heading?: string | undefined
  /** The choice in effect. */
  readonly choice: BrowserChoice
  /**
   * The person chose another of the two choices.
   * @param choice - the one chosen.
   */
  readonly onChoice: (choice: BrowserChoice) => void
  /** Whether the choices cannot be changed now, as while a change is being applied. */
  readonly disabled?: boolean | undefined
  /** Whether Browser is ready, drawn while the isolated browser is chosen. */
  readonly readiness: BrowserReadiness
  /** What to draw in place of the readiness while Browser is not in the profile, such as where adding it stands. */
  readonly notAdded?: ReactNode
  /** Read the readiness again, after a read that failed. */
  readonly onRetry: () => void
  /**
   * Open the Settings section a need is met in.
   * @param section - the section's id.
   */
  readonly onOpenSettings: (section: string) => void
}

/** The mark of each tone of a state line. */
const MARKS = { loading: '…', success: '✓', warning: '!', error: '✕' } as const

/**
 * One state line: a mark and a message, with an optional action.
 * @param props - the tone, the message and the action.
 * @returns the line.
 */
function Line({ tone, children, action }: { readonly tone: keyof typeof MARKS; readonly children: ReactNode; readonly action?: { readonly label: string; readonly onClick: () => void } }): ReactNode {
  return (
    <div className={css.line} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={css.mark} aria-hidden="true">{MARKS[tone]}</span>
      <span className={css.lineText}>{children}</span>
      {action !== undefined && <Button variant="outline" size="sm" className={css.button} onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}

/**
 * A command to run in a terminal, with a button that copies it and says whether the copy worked.
 * @param props - the command and the copy.
 * @returns the row.
 */
export function BrowserCommand({ command, t }: { readonly command: string; readonly t: BrowserTranslate }): ReactNode {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const copy = (): void => {
    navigator.clipboard.writeText(command).then(() => { setCopied('yes') }, () => { setCopied('failed') })
  }
  return (
    <span className={css.commandRow}>
      <code className={css.command}>{command}</code>
      <Button variant="outline" size="sm" className={css.button} aria-label={t('browser.copy.named', { command })} onClick={copy}>{t('browser.copy')}</Button>
      <span className={css.copied} aria-live="polite">{copied === 'yes' ? t('browser.copy.done') : copied === 'failed' ? t('browser.copy.failed') : ''}</span>
    </span>
  )
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when BrowserReadiness or RequirementFix widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled Browser readiness ${JSON.stringify(value)}`)
}

/**
 * The action that meets Browser's unmet need: a command to copy, a Settings section, or a page that says how.
 * @param props - the fix, the copy and the Settings opener.
 * @returns the control.
 */
function Fix({ fix, t, onOpenSettings }: { readonly fix: RequirementFix } & Pick<BrowserChoicesProps, 't' | 'onOpenSettings'>): ReactNode {
  switch (fix.kind) {
    case 'command':
      return (
        <div className={css.fix}>
          <span className={css.hint}>{t('browser.fix.command')}</span>
          <BrowserCommand command={fix.command} t={t} />
        </div>
      )
    case 'settings':
      return <Button variant="outline" size="sm" className={`${css.button} ${css.alignStart}`} onClick={() => { onOpenSettings(fix.section) }}>{t('browser.fix.settings')}</Button>
    case 'docs':
      return <a className={css.link} href={fix.url} target="_blank" rel="noopener noreferrer">{t('browser.fix.docs')}</a>
    case 'browse-pair':
      // The pairing steps belong to the own-browser pack's Needs setup panel in Plugins; Browser's choices never meet this fix.
      return null
    /* v8 ignore next 2 -- closed-union default only defends a future widening of RequirementFix */
    default:
      return assertNever(fix)
  }
}

/**
 * Whether Browser is ready, in one state line with the action that fixes it.
 * @param props - the readiness and the callbacks.
 * @returns the line, and the fix under it.
 */
function Readiness({ readiness, t, notAdded, onRetry, onOpenSettings }: Pick<BrowserChoicesProps, 'readiness' | 't' | 'notAdded' | 'onRetry' | 'onOpenSettings'>): ReactNode {
  switch (readiness.kind) {
    case 'checking':
      return <Line tone="loading">{t('browser.checking')}</Line>
    case 'ready':
      return <Line tone="success">{t('browser.ready')}</Line>
    case 'needs-setup':
      return (
        <>
          <Line tone="warning">{t('browser.needsSetup', { reason: readiness.reason })}</Line>
          <Fix fix={readiness.fix} t={t} onOpenSettings={onOpenSettings} />
        </>
      )
    case 'problem':
      return <Line tone="error">{t('browser.problem', { message: readiness.message })}</Line>
    case 'failed':
      return <Line tone="warning" action={{ label: t('browser.retry'), onClick: onRetry }}>{t('browser.unread')}</Line>
    case 'not-added':
      return notAdded ?? null
    /* v8 ignore next 2 -- closed-union default only defends a future widening of BrowserReadiness */
    default:
      return assertNever(readiness)
  }
}

/**
 * Draw the choices.
 * @param props - see {@link BrowserChoicesProps}.
 * @returns the group, and the readiness under it while the isolated browser is chosen.
 */
export function BrowserChoices({ t, heading, choice, onChoice, disabled = false, readiness, notAdded, onRetry, onOpenSettings }: BrowserChoicesProps): ReactNode {
  const id = useId()
  return (
    <section className={css.choices} aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className={css.heading}>{heading ?? t('browser.which')}</h3>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className={css.options}>
        {CHOICES.map(option => (
          <div key={option} className={css.option} data-selected={choice === option ? '' : undefined} data-disabled={disabled ? '' : undefined}>
            <input type="radio" className={css.radio} name={id} value={option} checked={choice === option} disabled={disabled}
              aria-labelledby={`${id}-${option}-title`} aria-describedby={`${id}-${option}-text`} onChange={() => { onChoice(option) }} />
            <span id={`${id}-${option}-title`} className={css.optionTitle}>{t(`browser.choice.${option}.title`)}</span>
            <span id={`${id}-${option}-text`} className={css.optionText}>{t(`browser.choice.${option}.text`)}</span>
          </div>
        ))}
      </div>
      {choice === 'isolated' && (
        <div className={css.readiness} aria-live="polite">
          <Readiness readiness={readiness} t={t} notAdded={notAdded} onRetry={onRetry} onOpenSettings={onOpenSettings} />
        </div>
      )}
    </section>
  )
}
