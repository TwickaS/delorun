/**
 * The providers step: a landing of provider cards to tick, a guided walk through each ticked provider (key, test, Skip and
 * Next) and a summary. A key is write-only here: a key Delorun already has shows as text (found, and where it came from) with no input until the person presses Replace key.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FooterPortal } from '../frame/StepFrame.tsx'
import { StepFooter } from '../frame/StepFooter.tsx'
import type { Guide } from '../guide.ts'
import { couldNotTest, didNotPass } from '../key-status.ts'
import { cardsOf, monogramOf, TEST_DELAY_MS, usableKey, type DirectoryEntry, type KeyProbe, type ProviderCard } from '../providers.ts'
import type { StepServices } from '../types.ts'
import type { LocalServer } from '../../wire.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Monogram } from '../ui/Card.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { FoundKey, sourceLine } from './FoundKey.tsx'
import { useStore } from './shared.ts'
import chevron from '../ui/Chevron.module.css'
import css from './models.module.css'
import shared from './steps.module.css'

/**
 * How a provider ended: connected (a key that works, or one already stored), saved with the test's failed verdict, saved
 * without a test result, or passed over.
 */
type Outcome = 'connected' | 'failed' | 'untested' | 'skipped'

/** How many providers a key alone connects the landing lists before the rest sit behind "Show all". */
const ADDABLE_SHOWN = 6

/** The props of the step. */
interface ModelsStepProps {
  /** The services the body draws with. */
  readonly services: StepServices
  /** The guide's shared state. */
  readonly guide: Guide
  /** Go on to the next step. */
  readonly next: () => void
  /** Go back to the previous step. */
  readonly back: () => void
  /** Whether the guide runs on a paired device, where the home refuses the key test once a PIN or any passkey exists. */
  readonly remote?: boolean
  /** Whether PIN mode is on; on a device the key test is then refused every time, so no Try again is offered. */
  readonly pinOn?: boolean
}

/**
 * The providers step.
 * @param props - the services, the guide and the dialog's `next` and `back`.
 * @returns the step body.
 */
export function ModelsStep({ services, guide, next, back, remote = false, pinOn = false }: ModelsStepProps): ReactNode {
  const { t, providers } = services
  const keys = useStore(guide.keys)
  const phase = useStore(guide.providersPhase)
  const [directory, setDirectory] = useState<readonly DirectoryEntry[] | undefined | 'loading'>('loading')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  const [index, setIndex] = useState(0)
  // A provider whose key failed and is tried again on its own; the walk then returns to the summary.
  const [only, setOnly] = useState<string | undefined>()
  // A key replaced from the landing: the walk shows that one provider's key field and returns to the landing.
  const [replacingOnly, setReplacingOnly] = useState(false)
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({})
  // The providers this walk visits, fixed when it starts so that finishing one does not shorten the queue under the index.
  const [order, setOrder] = useState<readonly string[]>([])
  const [expanded, setExpanded] = useState(false)
  // Coming back to the step starts from the cards, whatever phase it was left in.
  useEffect(() => { guide.setProvidersPhase('landing') }, [guide])
  useEffect(() => {
    let live = true
    void providers.directory().then((entries) => { if (live) setDirectory(entries) })
    return () => { live = false }
  }, [providers])
  const cards = keys.status === 'ready' && directory !== 'loading' && directory !== undefined
    ? cardsOf(keys.value, directory).map(card => card.custom === true ? { ...card, name: t('providers.custom.name') } : card)
    : undefined
  // A key found before the step opened starts ticked; later changes are the person's.
  useEffect(() => {
    if (cards === undefined || seeded) return
    setTicked(new Set(cards.filter(card => card.found).map(card => card.provider)))
    setSeeded(true)
  }, [cards, seeded])
  // The summary replaces the walk's key field, so focus returns to the step's heading rather than the page.
  useEffect(() => {
    if (phase === 'summary') document.querySelector<HTMLElement>('h2[data-modal-autofocus]')?.focus({ preventScroll: true })
  }, [phase])
  const walk = cards?.filter(card => ticked.has(card.provider)) ?? []
  const queue = only === undefined ? walk.filter(card => order.includes(card.provider)) : walk.filter(card => card.provider === only)

  const finishWalk = (): void => {
    guide.testKeys()
    guide.setProvidersPhase('summary')
  }
  const settle = (card: ProviderCard, outcome: Outcome): void => {
    setOutcomes(held => ({ ...held, [card.provider]: outcome }))
    if (replacingOnly) { setReplacingOnly(false); setOnly(undefined); guide.testKeys(); guide.setProvidersPhase('landing') }
    else if (index + 1 < queue.length) setIndex(index + 1)
    else { setOnly(undefined); finishWalk() }
  }

  const labels = { more: t('more'), less: t('less') }
  const headingId = useId()
  // Before the summary the step draws its own footer in the frame's pinned footer.
  if (keys.status === 'loading' || directory === 'loading') {
    return (
      <div className={shared.stack}>
        <StateLine tone="loading">{t('providers.loading')}</StateLine>
        <FooterPortal><StepFooter back={{ label: t('back'), onClick: back }} next={{ label: t('continue'), onClick: next }} /></FooterPortal>
      </div>
    )
  }
  if (cards === undefined) {
    return (
      <div className={shared.stack}>
        {/* On a device with a PIN set the key test is refused every time, so Try again would only fail again. Without a PIN
            it may pass (no passkey yet) or be refused (a passkey exists), so Try again stays with words that cover both. */}
        {remote && pinOn
          ? <StateLine tone="info">{t('providers.atComputer')}</StateLine>
          : remote
            ? <StateLine tone="info" action={{ label: t('key.again'), onClick: () => { guide.testKeys() } }}>{t('providers.atComputerMaybe')}</StateLine>
          : <StateLine tone="error" action={{ label: t('key.again'), onClick: () => { guide.testKeys() } }}>{t('providers.unread')}</StateLine>}
        <FooterPortal><StepFooter back={{ label: t('back'), onClick: back }} next={{ label: t('continue'), onClick: next }} /></FooterPortal>
      </div>
    )
  }
  if (phase === 'summary') {
    const rows = walk.map(card => ({ card, outcome: outcomes[card.provider] ?? 'skipped' }))
    const anyWorks = rows.some(({ outcome }) => outcome === 'connected')
    return (
      <div className={shared.stack}>
        <p className={shared.lead}>{t(anyWorks ? 'providers.summary.lead' : 'providers.summary.none')}</p>
        <ul className={shared.cards} aria-label={t('providers.summary.label')}>
          {rows.map(({ card, outcome }) => (
            <li key={card.provider}>
              <Card title={card.name} monogram={monogramOf(card)} labels={labels} action={<span className={outcome === 'connected' ? shared.added : css.skipped}>{outcome === 'connected' ? <span aria-hidden="true">✓ </span> : null}{t(`providers.outcome.${outcome}`)}</span>}>
                {outcome === 'failed' && (
                  <StateLine tone="error" action={{ label: t('providers.tryAgain'), onClick: () => { setOnly(card.provider); setIndex(0); guide.setProvidersPhase('walk') } }}>
                    {t('providers.failedHelp', { name: card.name })}
                    {card.keyPage !== undefined && <> <a className={css.link} href={card.keyPage} target="_blank" rel="noopener noreferrer">{t('providers.getKey')}</a></>}
                  </StateLine>
                )}
              </Card>
            </li>
          ))}
        </ul>
        <Button variant="outline" className={css.addAnother} onClick={() => { setIndex(0); guide.setProvidersPhase('landing') }}>{t('providers.addAnother')}</Button>
      </div>
    )
  }
  if (phase === 'walk' && queue[index] !== undefined) {
    const card = queue[index]
    return (
      <WalkScreen key={card.provider} card={card} services={services} place={{ k: index + 1, n: queue.length }} startReplacing={replacingOnly}
        onBack={() => { if (replacingOnly) { setReplacingOnly(false); setOnly(undefined); guide.setProvidersPhase('landing') } else if (index > 0) setIndex(index - 1); else if (only !== undefined) { setOnly(undefined); guide.setProvidersPhase('summary') } else guide.setProvidersPhase('landing') }}
        onSkip={() => { settle(card, 'skipped') }} onDone={(outcome) => { settle(card, outcome) }} />
    )
  }
  // A provider that already ended connected or saved is not walked again when the person comes back to add another.
  const pending = walk.filter(card => outcomes[card.provider] === undefined || outcomes[card.provider] === 'skipped')
  const connect = (): void => {
    setIndex(0)
    if (pending.length === 0) { finishWalk(); return }
    setOrder(pending.map(card => card.provider))
    guide.setProvidersPhase('walk')
  }
  // Every ticked provider already has a key that passed: there is nothing to walk through, so the primary goes straight on.
  const keysAllFound = walk.length > 0 && walk.every(card => card.found && !didNotPass(card.result))
  const firstExplained = cards.find(card => card.found && !didNotPass(card.result))?.provider
  const present = (card: ProviderCard): ReactNode => {
    const works = card.found && !didNotPass(card.result) && !couldNotTest(card.result)
    return (
      <li key={card.provider}>
        <Card title={card.name} monogram={monogramOf(card)} labels={labels} selected={ticked.has(card.provider)} description={card.custom === true ? t('providers.custom.hint') : undefined}
          action={(
            <span className={css.trail}>
              {works && <span className={css.status} role="status"><span className={css.dot} aria-hidden="true" />{t('providers.connected')}</span>}
              <label className={css.tickLabel}>
                <input type="checkbox" className={css.tick} checked={ticked.has(card.provider)} aria-label={t('providers.use', { name: card.name })} onChange={(event) => {
                  const on = event.currentTarget.checked
                  setTicked((held) => { const copy = new Set(held); if (on) copy.add(card.provider); else copy.delete(card.provider); return copy })
                  // Ticking a provider again asks for its key again, even where it ended earlier.
                  setOutcomes((held) => Object.fromEntries(Object.entries(held).filter(([provider]) => provider !== card.provider)))
                }} />
              </label>
            </span>
          )}>
          {card.found && (didNotPass(card.result)
            ? <StateLine tone="warning">{t('providers.foundFailed')}</StateLine>
            : couldNotTest(card.result) && <StateLine tone="info">{t('keyStatus.unverified')}</StateLine>)}
          {card.found && (
            <div className={css.meta}>
              <p className={css.source}>{sourceLine(t, card.source)}</p>
              <div className={css.actions}>
                <Button variant="ghost" size="sm" className={css.quiet} onClick={() => {
                  setTicked(held => new Set(held).add(card.provider))
                  setOutcomes(held => Object.fromEntries(Object.entries(held).filter(([provider]) => provider !== card.provider)))
                  setOnly(card.provider); setReplacingOnly(true); setIndex(0); guide.setProvidersPhase('walk')
                }}>{t('providers.replace')}</Button>
                {/* The explanation is the same for every key Delorun found, so it hangs off the first one only. */}
                {card.provider === firstExplained && <FoundKey t={t} source={undefined} compact />}
              </div>
            </div>
          )}
        </Card>
      </li>
    )
  }
  const foundCards = cards.filter(card => card.found)
  const addable = cards.filter(card => !card.found)
  const shown = expanded ? addable : addable.filter((card, place) => place < ADDABLE_SHOWN || card.custom === true || ticked.has(card.provider))
  return (
    <div className={shared.stack}>
      <p className={shared.lead}>{t('providers.lead')}</p>
      {cards.length === 0 ? <StateLine tone="warning">{t('providers.none')}</StateLine> : (
        <>
          {foundCards.length > 0 && <ul className={shared.cards}>{foundCards.map(present)}</ul>}
          {addable.length > 0 && (
            <section className={shared.stack} aria-labelledby={`${headingId}-add`}>
              <h3 id={`${headingId}-add`} className={css.addHeading}>{t(foundCards.length > 0 ? 'providers.add.heading' : 'providers.add.headingFirst')}</h3>
              <ul className={shared.cards}>{shown.map(present)}</ul>
              {addable.length > shown.length || expanded
                ? <Button variant="ghost" className={css.showAll} aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>
                  {expanded ? t('providers.add.showFewer') : t('providers.add.showAll', { n: String(addable.length) })}
                </Button> : null}
            </section>
          )}
        </>
      )}
      <LocalServers services={services} taken={new Set(cards.map(card => card.provider))} />
      <p className={shared.hint}>{t('welcome.model.hint')}</p>
      <FooterPortal>
        <StepFooter back={{ label: t('back'), onClick: back }}
          next={walk.length === 0 ? { label: t('providers.continueNoKey'), onClick: next }
            : keysAllFound ? { label: t('continue'), onClick: next } : { label: t('providers.connect'), onClick: connect }} />
      </FooterPortal>
    </div>
  )
}

/** The name a found local server is shown under. */
const LOCAL_NAMES: Readonly<Record<LocalServer['kind'], string>> = { 'ollama': 'Ollama', 'lm-studio': 'LM Studio' }

/**
 * Offer each local model server the host found, unless a route of that name already exists: its address and model count,
 * and an Add that asks for confirmation before anything is written. From a phone the write is left to the computer.
 * @param props - the services and the route ids that already exist.
 * @returns the offers, or nothing when no server was found.
 */
function LocalServers({ services, taken }: { readonly services: StepServices; readonly taken: ReadonlySet<string> }): ReactNode {
  const { t, host, providers } = services
  const [servers, setServers] = useState<readonly LocalServer[]>([])
  const [asking, setAsking] = useState<string | undefined>()
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void host.localModels().then((found) => { if (live) setServers(found ?? []) })
    return () => { live = false }
  }, [host])
  const confirm = (server: LocalServer): void => {
    setFailed(false)
    void providers.declareLocal(server).then((ok) => {
      if (ok) { setAsking(undefined); setAdded(held => new Set(held).add(server.kind)) } else setFailed(true)
    })
  }
  const offers = servers.filter(server => !taken.has(server.kind) || added.has(server.kind))
  if (offers.length === 0) return null
  return (
    <ul className={shared.cards} aria-label={t('local.label')}>
      {offers.map(server => (
        <li key={server.kind}>
          <Card title={LOCAL_NAMES[server.kind]} labels={{ more: t('more'), less: t('less') }}
            action={added.has(server.kind) ? <span className={shared.added}><span aria-hidden="true">✓ </span>{t('bundle.added')}</span>
              : asking === server.kind ? undefined
                : <Button variant="outline" size="sm" className={shared.inline} aria-label={t('local.addNamed', { name: LOCAL_NAMES[server.kind] })} onClick={() => { setAsking(server.kind) }}>{t('bundle.add')}</Button>}>
            <StateLine tone="success">{t('local.found', { n: String(server.models.length), address: server.baseURL })}</StateLine>
            {asking === server.kind && (
              <div className={shared.stack}>
                <p className={shared.hint}>{t('local.confirm', { name: LOCAL_NAMES[server.kind], address: server.baseURL })}</p>
                <Button size="sm" className={shared.inline} onClick={() => { confirm(server) }}>{t('local.confirmYes')}</Button>
                <Button variant="outline" size="sm" className={shared.inline} onClick={() => { setAsking(undefined); setFailed(false) }}>{t('local.confirmNo')}</Button>
              </div>
            )}
            {failed && asking === server.kind && <StateLine tone="error">{t('local.failed')}</StateLine>}
          </Card>
        </li>
      ))}
    </ul>
  )
}

/** The props of one provider's screen in the walk. */
interface WalkProps {
  /** The provider. */
  readonly card: ProviderCard
  /** The services the screen draws with. */
  readonly services: StepServices
  /** Its place in the walk. */
  readonly place: { readonly k: number; readonly n: number }
  /** Go back to the previous provider, or to the cards. */
  readonly onBack: () => void
  /** The person passed over this provider. */
  readonly onSkip: () => void
  /** Start with the key field open, as after Replace key. */
  readonly startReplacing?: boolean
  /** This provider is done. */
  readonly onDone: (outcome: Outcome) => void
}

/** What the screen knows of the typed key. */
type Test = { readonly state: 'idle' } | { readonly state: 'testing' } | { readonly state: 'invalid' } | { readonly state: 'done'; readonly probe: KeyProbe }

/**
 * One provider's screen: the key field, tested a moment after it is typed or pasted, and Skip and Next.
 * @param props - the provider, the services, its place and the two exits.
 * @returns the screen.
 */
function WalkScreen({ card, services, place, startReplacing = false, onBack, onSkip, onDone }: WalkProps): ReactNode {
  const { t, providers } = services
  const [key, setKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [endpointName, setEndpointName] = useState('')
  const [test, setTest] = useState<Test>({ state: 'idle' })
  const [saving, setSaving] = useState(false)
  // A found key shows as text; the input exists only after Replace key.
  const [replacing, setReplacing] = useState(startReplacing)
  const showField = !card.found || replacing
  const [problem, setProblem] = useState(false)
  const latest = useRef(0)
  const id = useId()
  const keyField = useRef<HTMLInputElement>(null)
  // Each provider's screen mounts fresh, so its key field takes focus when it appears.
  useEffect(() => { if (showField) keyField.current?.focus({ preventScroll: true }) }, [showField])
  const address = baseURL.trim() === '' ? undefined : baseURL.trim()
  const custom = card.custom === true
  // An endpoint is tested only once its address is one a request can go to.
  const addressUsable = address !== undefined && /^https?:\/\/\S+$/.test(address)
  const addressInvalid = custom && address !== undefined && !addressUsable
  useEffect(() => {
    const request = ++latest.current
    if (key === '' || (custom && !addressUsable)) { setTest({ state: 'idle' }); return }
    const usable = usableKey(key)
    if (usable === undefined) { setTest({ state: 'invalid' }); return }
    setTest({ state: 'testing' })
    const timer = setTimeout(() => {
      void providers.probe(card.entry, usable, address).then((probe) => { if (latest.current === request) setTest({ state: 'done', probe }) })
    }, TEST_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [key, address, card.entry, providers, custom, addressUsable])
  const typed = usableKey(key)
  const next = (): void => {
    if (typed === undefined) { onDone(card.found ? 'connected' : 'skipped'); return }
    setSaving(true)
    setProblem(false)
    const write = custom && address !== undefined
      ? providers.declareCustom({ name: endpointName.trim(), baseURL: address, key: typed })
      : providers.save(card.entry, typed, address)
    void write.then((saved) => {
      setSaving(false)
      if (!saved) { setProblem(true); return }
      onDone(test.state !== 'done' || test.probe.kind === 'unchecked' ? 'untested' : test.probe.kind === 'works' ? 'connected' : 'failed')
    })
  }
  const works = test.state === 'done' && test.probe.kind === 'works' ? test.probe : undefined
  const invalid = test.state === 'invalid'
  const incomplete = custom && (endpointName.trim() === '' || !addressUsable)
  return (
    <div className={shared.stack}>
      {place.n > 1 && <p className={css.place}>{t('providers.place', { k: String(place.k), n: String(place.n) })}</p>}
      <h3 className={css.provider}><Monogram name={card.name} letters={monogramOf(card)} />{card.name}</h3>
      {custom && (
        <>
          <div className={css.field}>
            <label htmlFor={`${id}-name`} className={css.label}>{t('providers.custom.nameField')}</label>
            <input id={`${id}-name`} className={css.input} type="text" autoComplete="off" spellCheck={false} value={endpointName}
              onChange={(event) => { setEndpointName(event.currentTarget.value) }} />
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-url`} className={css.label}>{t('providers.baseURL')}</label>
            <input id={`${id}-url`} className={css.input} type="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={baseURL}
              aria-invalid={addressInvalid || undefined} onChange={(event) => { setBaseURL(event.currentTarget.value) }} />
            {addressInvalid && <StateLine tone="warning">{t('providers.custom.invalid')}</StateLine>}
          </div>
        </>
      )}
      {!showField ? (
        <div className={css.field}>
          {didNotPass(card.result)
            ? <StateLine tone="warning">{t('providers.foundFailed')}</StateLine>
            : <StateLine tone="success">{t(services.remote ? 'providers.found.host' : 'providers.found')}</StateLine>}
          <FoundKey t={t} source={card.source} />
          <Button variant="outline" size="sm" className={`${css.replace} ${shared.inline}`} onClick={() => { setReplacing(true) }}>{t('providers.replace')}</Button>
        </div>
      ) : (
        <div className={css.field}>
          <label htmlFor={`${id}-key`} className={css.label}>{t('providers.key')}</label>
          <input id={`${id}-key`} ref={keyField} className={css.input} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
            value={key} aria-describedby={`${id}-state`} aria-invalid={invalid || undefined}
            onChange={(event) => { setKey(event.currentTarget.value) }} />
          <div id={`${id}-state`} className={css.keyState}>
            {test.state === 'testing' && <StateLine tone="loading">{t('providers.testing')}</StateLine>}
            {invalid && <StateLine tone="warning">{t('providers.invalid')}</StateLine>}
            {works !== undefined && <StateLine tone="success">{t('providers.works', { n: String(works.models) })}{works.defaultModel === undefined ? null : <span className={css.defaultModel}>{t('providers.default', { model: works.defaultModel })}</span>}</StateLine>}
            {test.state === 'done' && test.probe.kind === 'failed' && <StateLine tone="error">{t('providers.failed')}</StateLine>}
            {test.state === 'done' && test.probe.kind === 'unchecked' && <StateLine tone="info">{t('providers.unchecked')}</StateLine>}
            {problem && <StateLine tone="error" action={{ label: t('retry'), onClick: next }}>{t(custom ? 'providers.custom.failed' : 'providers.saveFailed')}</StateLine>}
          </div>
          {card.found && <Button variant="ghost" size="sm" className={`${css.replace} ${shared.inline}`} onClick={() => { if (startReplacing) { onBack(); return } setReplacing(false); setKey(''); setProblem(false) }}>{t('providers.replace.cancel')}</Button>}
          {card.keyPage !== undefined && (
            <a className={css.link} href={card.keyPage} target="_blank" rel="noopener noreferrer">{t('providers.getKey')}</a>
          )}
        </div>
      )}
      {card.needsBaseURL && !custom && (
        <details className={css.more}>
          <summary className={`${chevron.summary} ${css.moreSummary}`}>{t('providers.more')}</summary>
          <label htmlFor={`${id}-url`} className={css.label}>{t('providers.baseURL')}</label>
          <input id={`${id}-url`} className={css.input} type="url" autoComplete="off" spellCheck={false} value={baseURL}
            onChange={(event) => { setBaseURL(event.currentTarget.value) }} />
        </details>
      )}
      <FooterPortal>
        <StepFooter skip={{ label: t('providers.skipOne'), onClick: onSkip }} back={{ label: t('back'), onClick: onBack }}
          next={{ label: t('providers.next'), onClick: next, disabled: saving || invalid || incomplete || (typed === undefined && (!card.found || replacing)), focus: showField ? undefined : card.provider }} />
      </FooterPortal>
    </div>
  )
}
