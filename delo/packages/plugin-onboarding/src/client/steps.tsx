/**
 * Onboarding's built-in step bodies: the preview notice, language and look, agents, recommended plugins, reach and
 * start. The dialog draws each step's heading, Back and Continue around its body.
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { BundleView } from './bundles.ts'
import { FolderChooser, problemText, type FolderProblem } from './FolderChooser.tsx'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, PALETTE_CHOICES, PALETTE_PREVIEWS, type SchemeColours } from './previews.ts'
import type { SchemePreference, StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** The props of a built-in step body. */
export interface StepProps {
  /** The services the body draws with. */
  readonly services: StepServices
}

/** The colour schemes the look step offers. */
const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/** The delegation bundles the agents step offers, by package name and the key of their copy. */
export const AGENT_BUNDLES = [
  { name: '@deepseek-ai/dsh-subagent-claude-code', key: 'claude' },
  { name: '@deepseek-ai/dsh-subagent-codex', key: 'codex' },
] as const

/**
 * The preview notice: bundle-local's copy, shown unchanged.
 * @param props - the services; the notice comes from them.
 * @returns the paragraphs, or nothing without a notice.
 */
export function NoticeStep({ services }: StepProps): ReactNode {
  const paragraphs = services.notice?.paragraphs() ?? []
  return (
    <div className={css.copy}>
      {paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </div>
  )
}

/** One choice of a set of chips. */
interface ChipOption {
  /** Unique within the set. */
  readonly key: string
  /** Whether it is the chosen one. */
  readonly checked: boolean
  /** Whether it cannot be chosen now. */
  readonly disabled?: boolean
  /** Choose it. */
  readonly onSelect: () => void
  /** What the chip shows; its text is its name. */
  readonly content: ReactNode
}

/** How each key moves within a radio group: a step forward or back, wrapping, or to the first or last choice. */
const RADIO_KEYS: Readonly<Record<string, -1 | 1 | 'first' | 'last'>> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last',
}

/**
 * A labelled set of chips as one radio group: one tab stop, on the chosen chip or else the first that can be chosen,
 * and the arrow keys, Home and End move to a chip and choose it, skipping chips that cannot be chosen. A group whose
 * choice has a large effect, such as leaving Delo's look, is `manual`: the keys only move focus, and Space or Enter
 * chooses.
 * @param props - the group's label, its choices and whether moving focus leaves the choice alone.
 * @returns the group.
 */
function Choices({ label, options, manual = false }: { readonly label: string; readonly options: readonly ChipOption[]; readonly manual?: boolean }): ReactNode {
  const id = useId()
  const enabled = options.filter(option => option.disabled !== true)
  const stop = enabled.find(option => option.checked) ?? enabled[0]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = RADIO_KEYS[event.key]
    if (move === undefined) return
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')]
    const from = radios.indexOf(event.target as HTMLButtonElement)
    if (from < 0) return
    event.preventDefault()
    const to = move === 'first' ? 0 : move === 'last' ? radios.length - 1 : (from + move + radios.length) % radios.length
    const radio = radios[to] as HTMLButtonElement
    radio.focus()
    if (!manual && radio.getAttribute('aria-checked') !== 'true') radio.click()
  }
  return (
    <div className={css.field}>
      <span id={id} className={css.label}>{label}</span>
      <div className={css.chips} role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map(option => (
          <button key={option.key} type="button" role="radio" aria-checked={option.checked} disabled={option.disabled}
            tabIndex={option === stop ? 0 : -1} className={css.chip} onClick={option.onSelect}>
            {option.content}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A palette's two schemes side by side, each with a line in its text colour and a dot in its accent. */
function PaletteSwatch({ light, dark }: { readonly light: SchemeColours; readonly dark: SchemeColours }): ReactNode {
  const half = (colours: SchemeColours): CSSProperties => (
    { '--half-page': colours.page, '--half-text': colours.text, '--half-accent': colours.accent } as CSSProperties
  )
  return (
    <span className={css.swatch} aria-hidden="true">
      <span className={css.half} style={half(light)}><span className={css.line} /><span className={css.dot} /></span>
      <span className={css.half} style={half(dark)}><span className={css.line} /><span className={css.dot} /></span>
    </span>
  )
}

/**
 * Language, colour scheme, theme, accent and the choice of Delo's look or the stock look.
 * @param props - the services.
 * @returns the step body.
 */
export function LookStep({ services }: StepProps): ReactNode {
  const { t, appearance, language, scheme, look } = services
  const locale = useSyncExternalStore(useCallback(listener => language.subscribe(listener), [language]), () => language.getSnapshot())
  const preference = useSyncExternalStore(useCallback(listener => scheme.subscribe(listener), [scheme]), () => scheme.get())
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const [failed, setFailed] = useState(false)
  const palette = settings.value?.palette ?? 'soft'
  const accent = settings.value?.accent ?? 'peach'
  const save = (write: Promise<boolean>): void => {
    setFailed(false)
    write.then((ok) => { if (!ok) setFailed(true) }, () => { setFailed(true) })
  }
  const disabled = !settings.writable
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('look.lead')}</p>
      <Choices label={t('look.language')} options={locale.locales.map(each => ({
        key: each.id, checked: locale.active === each.id, onSelect: () => { language.setLocale(each.id) }, content: each.label,
      }))} />
      <Choices label={appearance('mode')} options={SCHEMES.map(value => ({
        key: value, checked: preference === value, onSelect: () => { scheme.set(value) }, content: appearance(`mode.${value}`),
      }))} />
      <Choices label={appearance('palette')} options={PALETTE_CHOICES.map(value => ({
        key: value, checked: palette === value, disabled,
        onSelect: () => { if (palette !== value) save(look.settings.set('palette', value)) },
        content: (
          <>
            <PaletteSwatch light={PALETTE_PREVIEWS[value].light} dark={PALETTE_PREVIEWS[value].dark} />
            {appearance(`palette.${value}`)}
          </>
        ),
      }))} />
      {palette === 'soft'
        ? (
          <Choices label={appearance('accent')} options={ACCENT_PRESETS.map(value => ({
            key: value, checked: accent === value, disabled,
            onSelect: () => { if (accent !== value) save(look.settings.set('accent', value)) },
            content: (
              <>
                <span className={css.accentDot} aria-hidden="true"
                  style={{ '--accent-light': ACCENT_PREVIEWS[value].light, '--accent-dark': ACCENT_PREVIEWS[value].dark } as CSSProperties} />
                {appearance(`accent.${value}`)}
              </>
            ),
          }))} />
        )
        : <p className={css.hint}>{appearance('accent.byTheme')}</p>}
      <Choices label={t('look.studio')} manual options={[
        { key: 'delo', checked: true, disabled, onSelect: () => {}, content: appearance('look.delo') },
        { key: 'stock', checked: false, disabled, onSelect: () => { save(look.useStockLook()) }, content: appearance('look.stock') },
      ]} />
      <p className={css.hint}>{t('look.studio.lead')}</p>
      {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
    </div>
  )
}

/** What a bundle card's button and status show for one state; the Add button's name says what it adds. */
function BundleAction({ view, services, name, title }: {
  readonly view: BundleView | undefined
  readonly services: StepServices
  readonly name: string
  readonly title: string
}): ReactNode {
  const { t, bundles } = services
  const state = view?.state ?? 'checking'
  switch (state) {
    case 'checking':
      return <span className={css.status}>{t('bundle.checking')}</span>
    case 'available':
      return (
        <Button variant="outline" size="sm" aria-label={t('bundle.addNamed', { name: title })} onClick={() => { void bundles.install(name) }}>
          {t('bundle.add')}
        </Button>
      )
    case 'installing':
      return <span className={css.status}>{t('bundle.adding')}</span>
    case 'installed':
      return <span className={css.status} data-tone="done">{t('bundle.added')}</span>
    case 'restart':
      return <span className={css.status} data-tone="done">{t('bundle.restart')}</span>
    case 'unavailable':
      return <PluginsAction status={t('bundle.unavailable')} services={services} />
    case 'failed':
      return <PluginsAction status={t('bundle.failed')} services={services} tone="failed" />
    /* v8 ignore next 2 -- closed-union default only defends future widening of BundleState */
    default:
      return assertNever(state)
  }
}

/** A status with the button that opens Plugins, for a bundle the buttons here cannot add. */
function PluginsAction({ status, services, tone }: { readonly status: string; readonly services: StepServices; readonly tone?: 'failed' }): ReactNode {
  const { t, bundles } = services
  return (
    <span className={css.failedAction}>
      <span className={css.status} data-tone={tone}>{status}</span>
      <Button variant="outline" size="sm" onClick={() => { bundles.openPlugins() }}>{t('bundle.open')}</Button>
    </span>
  )
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when BundleState widens without this switch */
function assertNever(value: never): never {
  throw new Error(`unhandled bundle state ${String(value)}`)
}

/** One offered bundle: its name and description, and the action for its state. */
function BundleCard({ name, title, description, services }: {
  readonly name: string
  readonly title: string
  readonly description: string | undefined
  readonly services: StepServices
}): ReactNode {
  const view = useSyncExternalStore(
    useCallback(listener => services.bundles.views.subscribe(listener), [services.bundles]),
    () => services.bundles.views.getSnapshot()[name],
  )
  return (
    <li className={css.card}>
      <div className={css.cardText}>
        <h4 className={css.cardTitle}>{title}</h4>
        {description !== undefined && <p className={css.cardLead}>{description}</p>}
      </div>
      <BundleAction view={view} services={services} name={name} title={title} />
    </li>
  )
}

/** Read which of some bundles are installed or available once the step opens. */
function useRefresh(services: StepServices, names: readonly string[]): void {
  const { bundles } = services
  const key = names.join('\n')
  useEffect(() => { bundles.refresh(key.split('\n')) }, [bundles, key])
}

/**
 * The Claude Code and Codex delegation bundles, offered with what running them means. Reading where they stand never
 * adds them; a bundle this installation does not include is shown as such, with a way to Plugins.
 * @param props - the services.
 * @returns the step body.
 */
export function AgentsStep({ services }: StepProps): ReactNode {
  const { t } = services
  useRefresh(services, AGENT_BUNDLES.map(each => each.name))
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('agents.lead')}</p>
      <p className={css.warning} role="note">{t('agents.warning')}</p>
      <ul className={css.cards}>
        {AGENT_BUNDLES.map(each => (
          <BundleCard key={each.name} name={each.name} title={t(`agents.${each.key}.title`)} description={t(`agents.${each.key}.description`)} services={services} />
        ))}
      </ul>
      <p className={css.hint}>{t('agents.later')}</p>
    </div>
  )
}

/**
 * The configured recommended packages, each with the title and description the plugin manager lists for it.
 * @param props - the services; the packages come from them.
 * @returns the step body.
 */
export function PluginsStep({ services }: StepProps): ReactNode {
  const { t, plugins, bundles, resolveText } = services
  useRefresh(services, plugins)
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('plugins.lead')}</p>
      <ul className={css.cards}>
        {plugins.map((name) => {
          const view = views[name]
          return (
            <BundleCard key={name} name={name} services={services}
              title={view?.title === undefined ? name : resolveText(view.title)}
              description={view?.description === undefined ? undefined : resolveText(view.description)} />
          )
        })}
      </ul>
      <p className={css.hint}>{t('plugins.later')}</p>
    </div>
  )
}

/**
 * Reach, where it can be turned on: what it does, the command that turns it on at the computer, and what a phone cannot do.
 * @param props - the services.
 * @returns the step body.
 */
export function ReachStep({ services }: StepProps): ReactNode {
  const { t } = services
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('reach.lead')}</p>
      <p className={css.text}>{t('reach.where')}</p>
      <p className={css.text}><code className={css.command}>{t('reach.command')}</code></p>
      <p className={css.text}>{t('reach.limits')}</p>
      <p className={css.hint}>{t('reach.skip')}</p>
    </div>
  )
}

/** The Start step's folder choice: nothing yet, its own chooser, or why the chosen folder was not added. */
export type FolderView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'browse' }
  | { readonly kind: 'problem'; readonly problem: FolderProblem }

/** The Start step's folder choice and what follows a folder added from its own chooser. */
export interface StartFolder {
  /** What the step shows below its copy. */
  readonly view: FolderView
  /**
   * Finish onboarding and open a chat in the workspace just added.
   * @param workspaceId - the workspace.
   */
  readonly added: (workspaceId: WorkspaceId) => void
}

/**
 * The last screen: where its button opens the chat, and what the chat offers. With no default workspace it says so and
 * the button chooses a folder; where the host has no native chooser the step shows its own, and a folder that was not
 * added shows why.
 * @param props - the services and the folder choice.
 * @returns the step body.
 */
export function StartStep({ services, folder }: StepProps & { readonly folder: StartFolder }): ReactNode {
  const { t, start } = services
  const target = useSyncExternalStore(start.target.subscribe, start.target.getSnapshot)
  const point = target.kind === 'default' ? t('start.point.default') : target.kind === 'none' ? t('start.point.none') : undefined
  const { view } = folder
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t(`start.lead.${target.kind}`)}</p>
      {point !== undefined && <p className={css.text}>{point}</p>}
      {view.kind === 'problem' && <p className={css.failure} role="alert">{problemText(t, view.problem)}</p>}
      {view.kind === 'browse' && <FolderChooser services={services} onAdded={folder.added} />}
      <p className={css.hint}>{t('start.later')}</p>
    </div>
  )
}
