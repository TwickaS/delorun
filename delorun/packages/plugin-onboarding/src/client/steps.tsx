/**
 * Onboarding's built-in step bodies except Workspace: Welcome, Look, Agents, Recommended plugins, Phone access and
 * Ready. The dialog draws each step's heading, Back and Continue around its body. Every state a step reads from the
 * harness (a key test, a sign-in, Tailscale) shows while it loads, when it is fine, and when it could not be read.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import type { AgentSignIn, TailscaleReadiness } from '../wire.ts'
import type { BundleView } from './bundles.ts'
import { Choices, PaletteSwatch } from './choices.tsx'
import { fits, folderOf, presentConnections, type Guide, type Store } from './guide.ts'
import { ACCENT_PRESETS, ACCENT_PREVIEWS, PALETTE_CHOICES, PALETTE_PREVIEWS } from './previews.ts'
import { STARTERS, starterSet } from './StarterPrompts.tsx'
import type { NoticeFace, ReachState, SchemePreference, StartTarget, StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** The props of a built-in step body. */
export interface StepProps {
  /** The services the body draws with. */
  readonly services: StepServices
  /** The guide's shared state. */
  readonly guide: Guide
}

/** The colour schemes the look step offers. */
const SCHEMES: readonly SchemePreference[] = ['light', 'dark', 'system']

/** The delegation bundles the agents step offers, by package name, the key of their copy and their connection id. */
export const AGENT_BUNDLES = [
  { name: '@deepseek-ai/dsh-subagent-claude-code', key: 'claude', agent: 'claude-code' },
  { name: '@deepseek-ai/dsh-subagent-codex', key: 'codex', agent: 'codex' },
] as const

/** The command that turns reach on at the computer. */
export const REACH_COMMAND = 'delorun reach on tailscale'

/** The command that approves a phone once reach is on. */
export const APPROVE_COMMAND = 'delorun devices approve'

/**
 * @param store - a store.
 * @returns its current value, re-rendering on change.
 */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.getSnapshot())
}

/**
 * A command to run in a terminal, with a button that copies it and says so.
 * @param props - the command and this plugin's copy.
 * @returns the command row.
 */
export function Command({ command, t }: { readonly command: string; readonly t: StepServices['t'] }): ReactNode {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const copy = (): void => {
    navigator.clipboard.writeText(command).then(() => { setCopied('yes') }, () => { setCopied('failed') })
  }
  return (
    <span className={css.commandRow}>
      <code className={css.command}>{command}</code>
      <Button variant="outline" size="sm" aria-label={t('copy.named', { command })} onClick={copy}>{t('copy')}</Button>
      <span className={css.status} aria-live="polite">{copied === 'yes' ? t('copy.done') : copied === 'failed' ? t('copy.failed') : ''}</span>
    </span>
  )
}

/** The tone of a status line: done, needs attention, or neutral. */
type Tone = 'done' | 'attention' | undefined

/**
 * Welcome: the language and the preview notice while it is owed.
 * @param props - the services, the guide and the preview notice when it is owed.
 * @returns the step body.
 */
export function WelcomeStep({ services, notice }: StepProps & { readonly notice: NoticeFace | undefined }): ReactNode {
  const { t, language } = services
  const locale = useSyncExternalStore(useCallback(listener => language.subscribe(listener), [language]), () => language.getSnapshot())
  const paragraphs = notice?.paragraphs() ?? []
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('welcome.lead')}</p>
      <Choices label={t('welcome.language')} options={locale.locales.map(each => ({
        key: each.id, checked: locale.active === each.id, onSelect: () => { language.setLocale(each.id) }, content: each.label,
      }))} />
      {paragraphs.length > 0 && (
        <div className={css.notice}>
          <h3 className={css.noticeTitle}>{notice?.title()}</h3>
          {paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </div>
      )}
    </div>
  )
}

/**
 * A small chat in the chosen look: a message of the person's, the agent's answer with a tool line, and the message
 * box. It draws with the studio's own colour tokens, so each choice shows in it at once.
 * @param props - this plugin's copy.
 * @returns the preview.
 */
function ChatPreview({ t }: { readonly t: StepServices['t'] }): ReactNode {
  return (
    <div className={css.preview} role="img" aria-label={t('look.preview')}>
      <span className={css.bubbleMine}>{t('look.preview.ask')}</span>
      <span className={css.bubbleAgent}>
        <span className={css.toolLine}>{t('look.preview.tool')}</span>
        {t('look.preview.answer')}
      </span>
      <span className={css.composer}><span>{t('look.preview.box')}</span><span className={css.send} /></span>
    </div>
  )
}

/**
 * Look: colour scheme, theme, accent and the choice of Delorun's look or the stock look, with a chat that shows the choice.
 * @param props - the services.
 * @returns the step body.
 */
export function LookStep({ services }: StepProps): ReactNode {
  const { t, appearance, scheme, look } = services
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
    <div className={css.lookGrid}>
      <div className={css.stack}>
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
          { key: 'delorun', checked: true, disabled, onSelect: () => {}, content: appearance('look.delorun') },
          { key: 'stock', checked: false, disabled, onSelect: () => { save(look.useStockLook()) }, content: appearance('look.stock') },
        ]} />
        <p className={css.hint}>{t('look.studio.lead')}</p>
        {failed && <p className={css.failure} role="alert">{t('saveFailed')}</p>}
      </div>
      <ChatPreview t={t} />
    </div>
  )
}

/** What a bundle card's button and status show for one state; the Add button's name says what it adds. */
function BundleAction({ view, services, name, title, onAdd }: {
  readonly view: BundleView | undefined
  readonly services: StepServices
  readonly name: string
  readonly title: string
  /** Replaces the direct install, as the agents' confirmation does. */
  readonly onAdd?: () => void
}): ReactNode {
  const { t, bundles } = services
  const state = view?.state ?? 'checking'
  switch (state) {
    case 'checking':
      return <span className={css.status}>{t('bundle.checking')}</span>
    case 'available':
      return (
        <Button variant="outline" size="sm" aria-label={t('bundle.addNamed', { name: title })} onClick={onAdd ?? (() => { void bundles.install(name) })}>
          {t(onAdd === undefined ? 'bundle.add' : 'bundle.addConfirm')}
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

/**
 * @param services - the services.
 * @param name - a package.
 * @returns where it stands, re-rendering on change.
 */
function useBundle(services: StepServices, name: string): BundleView | undefined {
  return useSyncExternalStore(
    useCallback(listener => services.bundles.views.subscribe(listener), [services.bundles]),
    () => services.bundles.views.getSnapshot()[name],
  )
}

/** One offered bundle: its name, description and a note, and the action for its state. */
function BundleCard({ name, title, description, note, services, onAdd, children }: {
  readonly name: string
  readonly title: string
  readonly description: string | undefined
  readonly note?: ReactNode
  readonly services: StepServices
  readonly onAdd?: () => void
  readonly children?: ReactNode
}): ReactNode {
  const view = useBundle(services, name)
  return (
    <li className={css.card}>
      <div className={css.cardMain}>
        <div className={css.cardText}>
          <h4 className={css.cardTitle}>{title}</h4>
          {description !== undefined && <p className={css.cardLead}>{description}</p>}
          {note}
        </div>
        <BundleAction view={view} services={services} name={name} title={title} {...onAdd === undefined ? {} : { onAdd }} />
      </div>
      {children}
    </li>
  )
}

/**
 * One bundled row the person can turn on: its title, description and icon from its package, and the action for its
 * state. Nothing is turned on unless the person presses the button.
 */
function RowCard({ id, services }: { readonly id: string; readonly services: StepServices }): ReactNode {
  const { t, bundles, resolveText } = services
  const view = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot()[id])
  const title = view?.title === undefined ? id : resolveText(view.title)
  const state = view?.state ?? 'checking'
  let action: ReactNode
  switch (state) {
    case 'checking':
      action = <span className={css.status}>{t('bundle.checking')}</span>
      break
    case 'available':
      action = <Button variant="outline" size="sm" aria-label={t('optional.turnOnNamed', { name: title })} onClick={() => { void bundles.enableRow(id) }}>{t('optional.turnOn')}</Button>
      break
    case 'installing':
      action = <span className={css.status}>{t('optional.turningOn')}</span>
      break
    case 'installed':
      action = <span className={css.status} data-tone="done">{t('optional.on')}</span>
      break
    case 'restart':
      action = <span className={css.status} data-tone="done">{t('optional.restart')}</span>
      break
    case 'unavailable':
      action = <PluginsAction status={t('bundle.unavailable')} services={services} />
      break
    case 'failed':
      action = <PluginsAction status={t('bundle.failed')} services={services} tone="failed" />
      break
    /* v8 ignore next 2 -- closed-union default only defends future widening of BundleState */
    default:
      return assertNever(state)
  }
  return (
    <li className={css.card}>
      <div className={css.cardMain}>
        {view?.icon !== undefined && <img className={css.cardIcon} src={view.icon} alt="" />}
        <div className={css.cardText}>
          <h4 className={css.cardTitle}>{title}</h4>
          {view?.description !== undefined && <p className={css.cardLead}>{resolveText(view.description)}</p>}
        </div>
        {action}
      </div>
    </li>
  )
}

/** Read which of some bundles are installed or available once the step opens. */
function useRefresh(services: StepServices, names: readonly string[]): void {
  const { bundles } = services
  const key = names.join('\n')
  useEffect(() => { if (key !== '') bundles.refresh(key.split('\n')) }, [bundles, key])
}

/** The tone of an agent's sign-in. */
const SIGN_IN_TONES: Readonly<Record<AgentSignIn, Tone>> = { found: 'done', missing: 'attention', unknown: undefined }

/**
 * One coding agent: where its sign-in stands and, after Add, what adding it means, confirmed with a second press.
 * @param props - the agent and the services.
 * @returns the card.
 */
function AgentCard({ agent, services, guide }: { readonly agent: typeof AGENT_BUNDLES[number] } & StepProps): ReactNode {
  const { t, bundles } = services
  const readiness = useStore(guide.readiness)
  const [confirming, setConfirming] = useState(false)
  const title = t(`agents.${agent.key}.title`)
  const signIn = readiness.status === 'ready' ? readiness.value.agents[agent.agent] : undefined
  const note = (
    <p className={css.status} data-tone={signIn === undefined ? undefined : SIGN_IN_TONES[signIn]}>
      {readiness.status === 'loading' ? t('agents.signIn.checking') : signIn === undefined ? t('agents.signIn.unread') : t(`agents.${agent.key}.signIn.${signIn}`)}
    </p>
  )
  return (
    <BundleCard name={agent.name} title={title} description={t(`agents.${agent.key}.description`)} note={note} services={services} onAdd={() => { setConfirming(true) }}>
      {confirming && (
        <div className={css.confirm} role="group" aria-label={t('agents.confirm.label', { name: title })}>
          <ul className={css.facts}>
            <li>{t('agents.confirm.handoff')}</li>
            <li>{t('agents.confirm.limits')}</li>
            <li>{t('agents.confirm.outside')}</li>
            <li>{t('agents.confirm.files')}</li>
            <li>{t('agents.confirm.billing')}</li>
          </ul>
          <div className={css.actions}>
            <Button variant="primary" size="sm" onClick={() => { setConfirming(false); void bundles.install(agent.name) }}>{t('bundle.addNamed', { name: title })}</Button>
            <Button variant="ghost" size="sm" onClick={() => { setConfirming(false) }}>{t('chooser.cancel')}</Button>
          </div>
        </div>
      )}
    </BundleCard>
  )
}

/**
 * Agents: Claude Code and Codex, each with its sign-in on this computer, added only after the person reads what adding
 * one means and confirms.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function AgentsStep({ services, guide }: StepProps): ReactNode {
  const { t } = services
  useRefresh(services, AGENT_BUNDLES.map(each => each.name))
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('agents.lead')}</p>
      <ul className={css.cards}>
        {AGENT_BUNDLES.map(agent => <AgentCard key={agent.name} agent={agent} services={services} guide={guide} />)}
      </ul>
      <p className={css.hint}>{t('agents.later')}</p>
    </div>
  )
}

/**
 * A connection id as the person knows it.
 * @param id - the id.
 * @param t - this plugin's copy.
 * @param providers - the model providers' names by route.
 * @returns the name.
 */
export function connectionName(id: string, t: StepServices['t'], providers: ReadonlyMap<string, string>): string {
  if (id === 'agent:claude-code') return t('agents.claude.title')
  if (id === 'agent:codex') return t('agents.codex.title')
  if (id === 'tool:tailscale') return 'Tailscale'
  return providers.get(id.slice('provider:'.length)) ?? id.slice(id.indexOf(':') + 1)
}

/**
 * A readable stand-in for a plugin's title while its registered title is unknown: the package name without its scope,
 * with dashes as spaces and a capital first letter, so a package id never shows.
 * @param name - the package name.
 * @returns the words, such as `Codex quota` for `@scope/codex-quota`.
 */
export function readableName(name: string): string {
  const words = name.slice(name.lastIndexOf('/') + 1).replaceAll('-', ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Recommended plugins: the configured packages, those that fit the person's connections first with the connections
 * named; a package that declares only connections the person lacks is left out. Packages that are not installed are
 * read from the registry only when the person asks.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function PluginsStep({ services, guide }: StepProps): ReactNode {
  const { t, plugins, optionalRows, bundles, resolveText } = services
  const keys = useStore(guide.keys)
  const readiness = useStore(guide.readiness)
  const recommendations = useStore(guide.recommendations)
  useEffect(() => { if (guide.recommendations.getSnapshot() === undefined) guide.recommend(false) }, [guide])
  const answer = recommendations?.status === 'ready' ? recommendations.value : undefined
  const present = presentConnections(keys, readiness)
  const shown = fits(plugins, answer, present)
  useRefresh(services, shown.map(each => each.name))
  const rowKey = optionalRows.join('\n')
  useEffect(() => { if (rowKey !== '') bundles.refreshRows(rowKey.split('\n')) }, [bundles, rowKey])
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  const names = new Map(keys.status === 'ready' ? keys.value.providers.map(each => [each.provider, each.name]) : [])
  const unread = answer?.plugins.some(each => each.source === 'unknown') === true && answer.registry === 'not-asked'
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('plugins.lead')}</p>
      <ul className={css.cards}>
        {shown.map(({ name, matches }) => {
          const view = views[name]
          const note = matches.length === 0
            ? undefined
            : <p className={css.status} data-tone="done">{t('plugins.fits', { names: matches.map(id => connectionName(id, t, names)).join(', ') })}</p>
          return (
            <BundleCard key={name} name={name} services={services} note={note}
              title={view?.title === undefined ? readableName(name) : resolveText(view.title)}
              description={view?.description === undefined ? undefined : resolveText(view.description)} />
          )
        })}
        {optionalRows.map(id => <RowCard key={id} id={id} services={services} />)}
      </ul>
      <div aria-live="polite">
        {recommendations?.status === 'loading' && <p className={css.status}>{t('plugins.reading')}</p>}
        {shown.length === 0 && optionalRows.length === 0 && <p className={css.status}>{t('plugins.none')}</p>}
        {answer?.registry === 'unreachable' && <p className={css.status} data-tone="attention">{t('plugins.registry.unreachable')}</p>}
        {recommendations?.status === 'failed' && <p className={css.status} data-tone="attention">{t('plugins.unread')}</p>}
      </div>
      {unread && <Button variant="outline" size="sm" className={css.alignStart} onClick={() => { guide.recommend(true) }}>{t('plugins.registry')}</Button>}
      <p className={css.hint}>{t('plugins.later')}</p>
    </div>
  )
}

/** Tailscale's checks in the order a person fixes them, and the readiness state that stops at each. */
const TAILSCALE_CHECKS = [
  { key: 'installed', stops: 'not-installed' },
  { key: 'signedIn', stops: 'signed-out' },
  { key: 'https', stops: 'https-off' },
  { key: 'operator', stops: 'needs-operator' },
] as const

/** The command that fixes a check, where one does. */
const FIXES: Readonly<Partial<Record<typeof TAILSCALE_CHECKS[number]['key'], string>>> = { signedIn: 'tailscale up', operator: TAILSCALE_OPERATOR_COMMAND }

/**
 * Tailscale's checks as rows: each done, the first one missing with its fix, and the rest waiting.
 * @param props - the readiness and this plugin's copy.
 * @returns the rows.
 */
function TailscaleChecks({ tailscale, t }: { readonly tailscale: TailscaleReadiness; readonly t: StepServices['t'] }): ReactNode {
  const stop = TAILSCALE_CHECKS.findIndex(check => check.stops === tailscale.state)
  const reached = tailscale.state === 'ready' ? TAILSCALE_CHECKS.length : stop
  return (
    <ul className={css.rows}>
      {TAILSCALE_CHECKS.map((check, index) => {
        const state = index < reached ? 'done' : index === reached ? 'todo' : 'waiting'
        const fix = FIXES[check.key]
        return (
          <li key={check.key} className={css.check} data-state={state}>
            <span className={css.checkMark} aria-hidden="true">{state === 'done' ? '✓' : state === 'todo' ? '!' : '·'}</span>
            <span className={css.checkText}>
              <span>{t(`reach.check.${check.key}`)}<span className={css.visuallyHidden}>{t(`reach.state.${state}`)}</span></span>
              {state === 'todo' && <span className={css.hint}>{t(`reach.fix.${check.key}`)}</span>}
              {state === 'todo' && fix !== undefined && <Command command={fix} t={t} />}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Phone access, while reach is not set up: how far Tailscale is from serving the studio, with the command for the first
 * thing missing, then the commands that turn reach on and approve the phone, all run at this computer.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function ReachStep({ services, guide }: StepProps): ReactNode {
  const { t } = services
  const readiness = useStore(guide.readiness)
  const tailscale = readiness.status === 'ready' ? readiness.value.tailscale : undefined
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('reach.lead')}</p>
      <div aria-live="polite">
        {readiness.status === 'loading' && <p className={css.status}>{t('reach.checking')}</p>}
        {(readiness.status === 'failed' || tailscale?.state === 'unknown') && <p className={css.status} data-tone="attention">{t('reach.unread')}</p>}
      </div>
      {tailscale !== undefined && tailscale.state !== 'unknown' && <TailscaleChecks tailscale={tailscale} t={t} />}
      <div className={css.field}>
        <span className={css.label}>{t('reach.then')}</span>
        <Command command={REACH_COMMAND} t={t} />
        <Command command={APPROVE_COMMAND} t={t} />
        {tailscale?.state === 'ready' && <p className={css.hint}>{t('reach.address', { address: `https://${tailscale.dnsName}` })}</p>}
      </div>
      <p className={css.hint}>{t('reach.limits')}</p>
      <p className={css.hint}>{t('reach.pin')}</p>
    </div>
  )
}

/**
 * Phone access, for a studio opened through reach: one line saying that the phone is connected and that approvals and
 * full access are decided at the computer.
 * @param props - the services.
 * @returns the step body.
 */
export function RemoteReachStep({ services }: StepProps): ReactNode {
  return <p className={css.lead}>{services.t('reach.remote')}</p>
}

/** One line of the Ready checklist. */
interface CheckLine {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly tone: Tone
}

/**
 * Ready: what the guide set, line by line, and the starting prompts the first chat will offer in the chosen folder.
 * @param props - the services, the guide, the reach state and where the chat opens without a choice.
 * @returns the step body.
 */
export function ReadyStep({ services, guide, reach, target }: StepProps & { readonly reach: ReachState; readonly target: StartTarget }): ReactNode {
  const { t, appearance, look, plugins, optionalRows, bundles } = services
  const keys = useStore(guide.keys)
  const workspace = useStore(guide.workspace)
  const settings = useSyncExternalStore(useCallback(listener => look.settings.subscribe(listener), [look]), () => look.settings.getSnapshot())
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  const added = (name: string): boolean => views[name]?.state === 'installed' || views[name]?.state === 'restart'
  const working = keys.status === 'ready' ? keys.value.providers.filter(each => each.result === 'works') : []
  const palette = settings.value?.palette ?? 'soft'
  const agents = AGENT_BUNDLES.filter(each => added(each.name)).map(each => t(`agents.${each.key}.title`))
  const rowViews = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot())
  const extra = plugins.filter(added).length + optionalRows.filter(id => rowViews[id]?.state === 'installed' || rowViews[id]?.state === 'restart').length
  const lines: CheckLine[] = [
    working.length > 0
      ? { key: 'model', label: t('ready.model'), value: working.map(each => each.name).join(', '), tone: 'done' }
      : { key: 'model', label: t('ready.model'), value: t('ready.model.none'), tone: 'attention' },
    { key: 'look', label: t('ready.look'), value: palette === 'soft' ? `${appearance('palette.soft')} · ${appearance(`accent.${settings.value?.accent ?? 'peach'}`)}` : appearance(`palette.${palette}`), tone: undefined },
    { key: 'agents', label: t('ready.agents'), value: agents.length === 0 ? t('ready.none') : agents.join(', '), tone: agents.length === 0 ? undefined : 'done' },
    { key: 'plugins', label: t('ready.plugins'), value: extra === 0 ? t('ready.none') : t('ready.plugins.count', { count: String(extra) }), tone: extra === 0 ? undefined : 'done' },
    ...reach === 'absent' ? [] : [{ key: 'reach', label: t('ready.reach'), value: t(reach === 'set-up' ? 'ready.reach.on' : 'ready.reach.off'), tone: reach === 'set-up' ? 'done' as const : undefined }],
    workspace !== undefined
      ? { key: 'workspace', label: t('ready.workspace'), value: workspace.path, tone: undefined }
      : target.kind === 'other'
        ? { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.last'), tone: undefined }
        : { key: 'workspace', label: t('ready.workspace'), value: t('ready.workspace.none'), tone: 'attention' },
  ]
  const set = starterSet(folderOf(workspace) ?? '')
  return (
    <div className={css.stack}>
      <dl className={css.checklist}>
        {lines.map(line => (
          <div key={line.key} className={css.checkRow}>
            <dt>{line.label}</dt>
            <dd className={css.status} data-tone={line.tone}>{line.value}</dd>
          </div>
        ))}
      </dl>
      {(workspace !== undefined || target.kind === 'other') && (
        <div className={css.field}>
          <span className={css.label}>{t('ready.starters')}</span>
          <ul className={css.starterPreview}>
            {STARTERS.map(number => <li key={number}>{t(`starter.${set}.${number}.label`)}</li>)}
          </ul>
        </div>
      )}
      <p className={css.hint}>{t('start.later')}</p>
    </div>
  )
}
