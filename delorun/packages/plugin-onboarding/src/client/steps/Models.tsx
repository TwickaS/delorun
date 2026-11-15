/**
 * The providers step: a landing of provider cards to tick, a guided walk through each ticked provider (key, test, Skip and
 * Next) and a summary. A key is write-only here: the field never shows a stored key, only "Key found" or "Key saved".
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FooterPortal } from '../frame/StepFrame.tsx'
import { StepFooter } from '../frame/StepFooter.tsx'
import type { Guide } from '../guide.ts'
import { cardsOf, TEST_DELAY_MS, usableKey, type DirectoryEntry, type KeyProbe, type ProviderCard } from '../providers.ts'
import type { StepServices } from '../types.ts'
import { Card } from '../ui/Card.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { useStore } from './shared.ts'
import css from './models.module.css'
import shared from './steps.module.css'

/** How a provider ended: its key is stored (tested or not), it already had one, or it was passed over. */
type Outcome = 'connected' | 'saved' | 'skipped'

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
}

/**
 * The providers step.
 * @param props - the services, the guide and the dialog's `next` and `back`.
 * @returns the step body.
 */
export function ModelsStep({ services, guide, next, back }: ModelsStepProps): ReactNode {
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

  const labels = { more: t('more'), less: t('less') }
  // Before the summary the step draws its own footer in the frame's pinned footer.
  if (keys.status === 'loading' || directory === 'loading') {
    return (
      <div className={shared.stack}>
        <StateLine tone="loading">{t('providers.loading')}</StateLine>
        <FooterPortal><StepFooter back={{ label: t('back'), onClick: back }} next={{ label: t('providers.skip'), onClick: next }} /></FooterPortal>
      </div>
    )
  }
  if (cards === undefined) {
    return (
      <div className={shared.stack}>
        <StateLine tone="error" action={{ label: t('key.again'), onClick: () => { guide.testKeys() } }}>{t('providers.unread')}</StateLine>
        <FooterPortal><StepFooter back={{ label: t('back'), onClick: back }} next={{ label: t('providers.skip'), onClick: next }} /></FooterPortal>
      </div>
    )
  }
  if (phase === 'summary') {
    const rows = walk.map(card => ({ card, outcome: outcomes[card.provider] ?? 'skipped' }))
    return (
      <div className={shared.stack}>
        <p className={shared.lead}>{t('providers.summary.lead')}</p>
        <ul className={shared.cards} aria-label={t('providers.summary.label')}>
          {rows.map(({ card, outcome }) => (
            <li key={card.provider}>
              <Card title={card.name} labels={labels} action={<span className={outcome === 'skipped' ? css.skipped : shared.added}>{outcome === 'skipped' ? null : <span aria-hidden="true">✓</span>}{outcome === 'skipped' ? '' : ' '}{t(`providers.outcome.${outcome}`)}</span>} />
            </li>
          ))}
        </ul>
        <button type="button" className={shared.linkRow} onClick={() => { setIndex(0); guide.setProvidersPhase('landing') }}>{t('providers.change')}</button>
      </div>
    )
  }
  if (phase === 'walk' && walk[index] !== undefined) {
    const card = walk[index]
    return (
      <WalkScreen key={card.provider} card={card} services={services} place={{ k: index + 1, n: walk.length }}
        onBack={() => { if (index > 0) setIndex(index - 1); else guide.setProvidersPhase('landing') }}
        onSkip={() => { settle(card, 'skipped') }} onDone={(outcome) => { settle(card, outcome) }} />
    )
  }
  const connect = (): void => {
    setIndex(0)
    guide.setProvidersPhase('walk')
  }
  return (
    <div className={shared.stack}>
      <p className={shared.lead}>{t('providers.lead')}</p>
      {cards.length === 0 ? <StateLine tone="warning">{t('providers.none')}</StateLine> : (
        <ul className={shared.cards}>
          {cards.map(card => (
            <li key={card.provider}>
              <Card title={card.name} labels={labels} selected={ticked.has(card.provider)}
                action={(
                  <label className={css.tickLabel}>
                    <input type="checkbox" className={css.tick} checked={ticked.has(card.provider)} aria-label={t('providers.use', { name: card.name })} onChange={(event) => {
                      const on = event.currentTarget.checked
                      setTicked((held) => { const copy = new Set(held); if (on) copy.add(card.provider); else copy.delete(card.provider); return copy })
                    }} />
                  </label>
                )}>
                {card.found && <StateLine tone="success">{t('providers.found')}</StateLine>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className={shared.hint}>{t('welcome.model.hint')}</p>
      <FooterPortal>
        <StepFooter skip={{ label: t('providers.skip'), onClick: next }} back={{ label: t('back'), onClick: back }}
          next={{ label: t('providers.connect', { n: String(walk.length) }), onClick: connect, disabled: walk.length === 0 }} />
      </FooterPortal>
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
  /** Go back to the previous provider, or to the cards. */
  readonly onBack: () => void
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
function WalkScreen({ card, services, place, onBack, onSkip, onDone }: WalkProps): ReactNode {
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
  const invalid = test.state === 'invalid'
  return (
    <div className={shared.stack}>
      <p className={css.place}>{t('providers.place', { k: String(place.k), n: String(place.n) })}</p>
      <h3 className={css.provider}>{card.name}</h3>
      <div className={css.field}>
        <label htmlFor={`${id}-key`} className={css.label}>{t('providers.key')}</label>
        <input id={`${id}-key`} className={css.input} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={key} aria-describedby={`${id}-state`} aria-invalid={invalid || undefined}
          placeholder={card.found ? t('providers.key.keep') : ''} onChange={(event) => { setKey(event.currentTarget.value) }} />
        <div id={`${id}-state`} className={css.keyState}>
          {card.found && key === '' && <StateLine tone="success">{t('providers.found')}</StateLine>}
          {test.state === 'testing' && <StateLine tone="loading">{t('providers.testing')}</StateLine>}
          {invalid && <StateLine tone="warning">{t('providers.invalid')}</StateLine>}
          {works !== undefined && <StateLine tone="success">{t('providers.works', { n: String(works.models) })}{works.defaultModel === undefined ? null : <span className={css.defaultModel}>{t('providers.default', { model: works.defaultModel })}</span>}</StateLine>}
          {test.state === 'done' && test.probe.kind === 'failed' && <StateLine tone="error">{t('providers.failed')}</StateLine>}
          {problem && <StateLine tone="error" action={{ label: t('retry'), onClick: next }}>{t('providers.saveFailed')}</StateLine>}
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
      <FooterPortal>
        <StepFooter skip={{ label: t('providers.skipOne'), onClick: onSkip }} back={{ label: t('back'), onClick: onBack }}
          next={{ label: t('providers.next'), onClick: next, disabled: saving || invalid || (typed === undefined && !card.found) }} />
      </FooterPortal>
    </div>
  )
}
