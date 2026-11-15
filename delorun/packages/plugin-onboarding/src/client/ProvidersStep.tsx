/**
 * The providers step: a landing of provider cards to tick, a guided walk through each ticked provider (key, test, Skip and
 * Next) and a summary. A key is write-only here: the field never shows a stored key, only "Key found" or "Key saved".
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { cardsOf, TEST_DELAY_MS, usableKey, type DirectoryEntry, type KeyProbe, type ProviderCard } from './providers.ts'
import type { Guide, Store } from './guide.ts'
import type { StepServices } from './types.ts'
import css from './Onboarding.module.css'

/** How a provider ended: its key is stored (tested or not), it already had one, or it was passed over. */
type Outcome = 'connected' | 'saved' | 'skipped'

/** The props of the step. */
interface ProvidersStepProps {
  /** The services the body draws with. */
  readonly services: StepServices
  /** The guide's shared state. */
  readonly guide: Guide
  /** Go on to the next step. */
  readonly next: () => void
}

/**
 * @param store - a store.
 * @returns its current value, re-rendering on change.
 */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(useCallback(listener => store.subscribe(listener), [store]), () => store.getSnapshot())
}

/**
 * The providers step.
 * @param props - the services, the guide and the dialog's `next`.
 * @returns the step body.
 */
export function ProvidersStep({ services, guide, next }: ProvidersStepProps): ReactNode {
  const { t, providers } = services
  const keys = useStore(guide.keys)
  const phase = useStore(guide.providersPhase)
  const [directory, setDirectory] = useState<readonly DirectoryEntry[] | undefined | 'loading'>('loading')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  const [index, setIndex] = useState(0)
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({})
  // Coming back to the step starts from the cards, whatever phase it was left in.
  useEffect(() => { guide.setProvidersPhase('landing') }, [guide])
  useEffect(() => {
    let live = true
    void providers.directory().then((entries) => { if (live) setDirectory(entries) })
    return () => { live = false }
  }, [providers])
  const cards = keys.status === 'ready' && directory !== 'loading' && directory !== undefined ? cardsOf(keys.value, directory) : undefined
  // A key found before the step opened starts ticked; later changes are the person's.
  useEffect(() => {
    if (cards === undefined || seeded) return
    setTicked(new Set(cards.filter(card => card.found).map(card => card.provider)))
    setSeeded(true)
  }, [cards, seeded])
  const walk = cards?.filter(card => ticked.has(card.provider)) ?? []

  const finishWalk = (): void => {
    guide.testKeys()
    guide.setProvidersPhase('summary')
  }
  const settle = (card: ProviderCard, outcome: Outcome): void => {
    setOutcomes(held => ({ ...held, [card.provider]: outcome }))
    if (index + 1 < walk.length) setIndex(index + 1)
    else finishWalk()
  }

  // The dialog's own buttons are hidden here, so every state before the summary has its own way out.
  if (keys.status === 'loading' || directory === 'loading') {
    return (
      <div className={css.stack}>
        <p className={css.status} role="status">{t('providers.loading')}</p>
        <div className={css.actions}><Button variant="ghost" onClick={next}>{t('providers.skip')}</Button></div>
      </div>
    )
  }
  if (cards === undefined) {
    return (
      <div className={css.stack}>
        <p className={css.status} data-tone="attention" role="status">{t('providers.unread')}</p>
        <div className={css.actions}>
          <Button variant="outline" onClick={() => { guide.testKeys() }}>{t('key.again')}</Button>
          <Button variant="ghost" onClick={next}>{t('providers.skip')}</Button>
        </div>
      </div>
    )
  }
  if (phase === 'summary') {
    const rows = walk.map(card => ({ card, outcome: outcomes[card.provider] ?? 'skipped' }))
    return (
      <div className={css.stack}>
        <p className={css.lead}>{t('providers.summary.lead')}</p>
        <ul className={css.rows} aria-label={t('providers.summary.label')}>
          {rows.map(({ card, outcome }) => (
            <li key={card.provider} className={css.row}>
              <span>{card.name}</span>
              <span className={css.status} data-tone={outcome === 'skipped' ? undefined : 'done'}>{t(`providers.outcome.${outcome}`)}</span>
            </li>
          ))}
        </ul>
        <div className={css.actions}>
          <Button variant="ghost" onClick={() => { setIndex(0); guide.setProvidersPhase('landing') }}>{t('providers.change')}</Button>
        </div>
      </div>
    )
  }
  if (phase === 'walk' && walk[index] !== undefined) {
    const card = walk[index]
    return (
      <WalkScreen key={card.provider} card={card} services={services} place={{ k: index + 1, n: walk.length }}
        onSkip={() => { settle(card, 'skipped') }} onDone={(outcome) => { settle(card, outcome) }} />
    )
  }
  const connect = (): void => {
    setIndex(0)
    guide.setProvidersPhase('walk')
  }
  return (
    <div className={css.stack}>
      <p className={css.lead}>{t('providers.lead')}</p>
      {cards.length === 0 ? <p className={css.status} data-tone="attention" role="status">{t('providers.none')}</p> : (
        <ul className={css.cards}>
          {cards.map(card => (
            <li key={card.provider}>
              <label className={css.card}>
                <input type="checkbox" className={css.tick} checked={ticked.has(card.provider)} onChange={(event) => {
                  const on = event.currentTarget.checked
                  setTicked((held) => { const copy = new Set(held); if (on) copy.add(card.provider); else copy.delete(card.provider); return copy })
                }} />
                <span className={css.cardName}>{card.name}</span>
                {card.found && <span className={css.status} data-tone="done">{t('providers.found')}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={css.actions}>
        <Button variant="primary" disabled={walk.length === 0} onClick={connect}>{t('providers.connect', { n: String(walk.length) })}</Button>
        <Button variant="ghost" onClick={next}>{t('providers.skip')}</Button>
      </div>
      <p className={css.hint}>{t('welcome.model.hint')}</p>
    </div>
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
  /** The person passed over this provider. */
  readonly onSkip: () => void
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
function WalkScreen({ card, services, place, onSkip, onDone }: WalkProps): ReactNode {
  const { t, providers } = services
  const [key, setKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [test, setTest] = useState<Test>({ state: 'idle' })
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(false)
  const latest = useRef(0)
  const id = useId()
  const address = baseURL.trim() === '' ? undefined : baseURL.trim()
  useEffect(() => {
    const request = ++latest.current
    if (key === '') { setTest({ state: 'idle' }); return }
    const usable = usableKey(key)
    if (usable === undefined) { setTest({ state: 'invalid' }); return }
    setTest({ state: 'testing' })
    const timer = setTimeout(() => {
      void providers.probe(card.entry, usable, address).then((probe) => { if (latest.current === request) setTest({ state: 'done', probe }) })
    }, TEST_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [key, address, card.entry, providers])
  const typed = usableKey(key)
  const next = (): void => {
    if (typed === undefined) { onDone(card.found ? 'connected' : 'skipped'); return }
    setSaving(true)
    setProblem(false)
    void providers.save(card.entry, typed, address).then((saved) => {
      setSaving(false)
      if (!saved) { setProblem(true); return }
      onDone(test.state === 'done' && test.probe.kind === 'works' ? 'connected' : 'saved')
    })
  }
  const works = test.state === 'done' && test.probe.kind === 'works' ? test.probe : undefined
  return (
    <div className={css.stack}>
      <p className={css.place}>{t('providers.place', { k: String(place.k), n: String(place.n) })}</p>
      <h3 className={css.label}>{card.name}</h3>
      <div className={css.field}>
        <label htmlFor={`${id}-key`} className={css.label}>{t('providers.key')}</label>
        <input id={`${id}-key`} className={css.input} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={key} aria-describedby={`${id}-state`} aria-invalid={test.state === 'invalid' || undefined}
          placeholder={card.found ? t('providers.key.keep') : ''} onChange={(event) => { setKey(event.currentTarget.value) }} />
        <div id={`${id}-state`} aria-live="polite" className={css.keyState}>
          {card.found && key === '' && <span className={css.status} data-tone="done">{t('providers.found')}</span>}
          {test.state === 'testing' && <span className={css.status}>{t('providers.testing')}</span>}
          {test.state === 'invalid' && <span className={css.status} data-tone="attention">{t('providers.invalid')}</span>}
          {works !== undefined && <span className={css.status} data-tone="done">{t('providers.works', { n: String(works.models) })}</span>}
          {works?.defaultModel !== undefined && <span className={css.status}>{t('providers.default', { model: works.defaultModel })}</span>}
          {test.state === 'done' && test.probe.kind === 'failed' && <span className={css.status} data-tone="attention">{t('providers.failed')}</span>}
          {problem && <span className={css.status} data-tone="attention">{t('providers.saveFailed')}</span>}
        </div>
        {card.keyPage !== undefined && (
          <a className={css.link} href={card.keyPage} target="_blank" rel="noopener noreferrer">{t('providers.getKey')}</a>
        )}
      </div>
      {card.needsBaseURL && (
        <details className={css.more}>
          <summary className={css.moreSummary}>{t('providers.more')}</summary>
          <label htmlFor={`${id}-url`} className={css.label}>{t('providers.baseURL')}</label>
          <input id={`${id}-url`} className={css.input} type="url" autoComplete="off" spellCheck={false} value={baseURL}
            onChange={(event) => { setBaseURL(event.currentTarget.value) }} />
        </details>
      )}
      <div className={css.actions}>
        <Button variant="ghost" onClick={onSkip}>{t('providers.skipOne')}</Button>
        <Button variant="primary" disabled={saving || test.state === 'invalid' || (typed === undefined && !card.found)} onClick={next}>{t('providers.next')}</Button>
      </div>
    </div>
  )
}
