/**
 * Onboarding's built-in step bodies: the preview notice, language and look, agents, recommended plugins, reach and
 * start. The dialog draws each step's heading, Back and Continue around its body.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { BundleView } from './bundles.ts'
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

/** The group label and the group of a set of choices. */
function Choices({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <div className={css.field}>
      <span id={id} className={css.label}>{label}</span>
      <div className={css.chips} role="radiogroup" aria-labelledby={id}>{children}</div>
    </div>
  )
}

/** One choice of a radio group. */
function Chip({ checked, disabled, onSelect, children }: {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={disabled} className={css.chip} onClick={onSelect}>
      {children}
    </button>
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
      <Choices label={t('look.language')}>
        {locale.locales.map(each => (
          <Chip key={each.id} checked={locale.active === each.id} onSelect={() => { language.setLocale(each.id) }}>{each.label}</Chip>
        ))}
      </Choices>
      <Choices label={appearance('mode')}>
        {SCHEMES.map(value => (
          <Chip key={value} checked={preference === value} onSelect={() => { scheme.set(value) }}>{appearance(`mode.${value}`)}</Chip>
        ))}
      </Choices>
      <Choices label={appearance('palette')}>
        {PALETTE_CHOICES.map(value => (
          <Chip key={value} checked={palette === value} disabled={disabled}
            onSelect={() => { if (palette !== value) save(look.settings.set('palette', value)) }}>
            <PaletteSwatch light={PALETTE_PREVIEWS[value].light} dark={PALETTE_PREVIEWS[value].dark} />
            {appearance(`palette.${value}`)}
          </Chip>
        ))}
      </Choices>
      {palette === 'soft'
        ? (
          <Choices label={appearance('accent')}>
            {ACCENT_PRESETS.map(value => (
              <Chip key={value} checked={accent === value} disabled={disabled}
                onSelect={() => { if (accent !== value) save(look.settings.set('accent', value)) }}>
                <span className={css.accentDot} aria-hidden="true"
                  style={{ '--accent-light': ACCENT_PREVIEWS[value].light, '--accent-dark': ACCENT_PREVIEWS[value].dark } as CSSProperties} />
                {appearance(`accent.${value}`)}
              </Chip>
            ))}
          </Choices>
        )
        : <p className={css.hint}>{appearance('accent.byTheme')}</p>}
      <Choices label={t('look.studio')}>
        <Chip checked disabled={disabled} onSelect={() => {}}>{appearance('look.delo')}</Chip>
        <Chip checked={false} disabled={disabled} onSelect={() => { save(look.useStockLook()) }}>{appearance('look.stock')}</Chip>
      </Choices>
      <p className={css.hint}>{t('look.studio.lead')}</p>
      {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
    </div>
  )
}

/** What a bundle card's button and status show for one state. */
function BundleAction({ view, services, name }: { readonly view: BundleView | undefined; readonly services: StepServices; readonly name: string }): ReactNode {
  const { t, bundles } = services
  const state = view?.state ?? 'checking'
  switch (state) {
    case 'checking':
      return <span className={css.status}>{t('bundle.checking')}</span>
    case 'available':
      return <Button variant="outline" size="sm" onClick={() => { void bundles.install(name) }}>{t('bundle.add')}</Button>
    case 'installing':
      return <span className={css.status}>{t('bundle.adding')}</span>
    case 'installed':
      return <span className={css.status} data-tone="done">{t('bundle.added')}</span>
    case 'restart':
      return <span className={css.status} data-tone="done">{t('bundle.restart')}</span>
    case 'unavailable':
      return <span className={css.status}>{t('bundle.unavailable')}</span>
    case 'failed':
      return (
        <span className={css.failedAction}>
          <span className={css.status}>{t('bundle.failed')}</span>
          <Button variant="outline" size="sm" onClick={() => { bundles.openPlugins() }}>{t('bundle.open')}</Button>
        </span>
      )
    /* v8 ignore next 2 -- closed-union default only defends future widening of BundleState */
    default:
      return assertNever(state)
  }
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
      <BundleAction view={view} services={services} name={name} />
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
 * The Claude Code and Codex delegation bundles, offered with what running them means. Reading where they stand never adds them.
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
 * Reach, explained: where it is set up, what the options are, and that it can wait.
 * @param props - the services.
 * @returns the step body.
 */
export function ReachStep({ services }: StepProps): ReactNode {
  const { t } = services
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('reach.lead')}</p>
      <p className={css.text}>{t('reach.where')}</p>
      <p className={css.text}>{t('reach.options')}</p>
      <p className={css.hint}>{t('reach.skip')}</p>
    </div>
  )
}

/**
 * The last screen: what its button does.
 * @param props - the services.
 * @returns the step body.
 */
export function StartStep({ services }: StepProps): ReactNode {
  const { t } = services
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('start.lead')}</p>
      <p className={css.text}>{t('start.point')}</p>
      <p className={css.hint}>{t('start.later')}</p>
    </div>
  )
}
