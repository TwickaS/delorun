/**
 * Recommended plugins: the configured packages, those that fit the person's connections first with the connections
 * named; a package that declares only connections the person lacks is left out. Packages that are not installed are
 * read from the registry only when the person asks.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { BROWSER_BUNDLE } from '@delorun/browser-setup'
import { packTitle } from '@delorun/plugin-downloads/row'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { fits, presentConnections } from '../guide.ts'
import type { OnboardingLocaleKey } from '../locales.ts'
import type { StepServices } from '../types.ts'
import { Notice } from '../ui/Notice.tsx'
import { StateLine } from '../ui/StateLine.tsx'
import { BundleCard, RowCard } from './BundleCard.tsx'
import { readableName, useRefresh, useStore, type StepProps } from './shared.ts'
import css from './steps.module.css'

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

export { readableName }

/**
 * The guide's descriptions of Delorun's plugin packs; their titles are the downloads panel's (`packTitle`), so a pack
 * reads the same in both. Both win over the package's own words, so the packs that touch Claude Code, Codex or a
 * browser read apart from the Agents and Browser steps, and a pack not in the profile yet, whose package the studio
 * cannot read before it downloads, still has a title.
 */
const PACK_CARDS: Readonly<Record<string, OnboardingLocaleKey>> = {
  '@delorun/bundle-browser': 'plugins.pack.browser.description',
  '@delorun/bundle-real-browser': 'plugins.pack.realBrowser.description',
  '@delorun/bundle-code-intelligence': 'plugins.pack.codeIntelligence.description',
  '@delorun/bundle-agent-hooks': 'plugins.pack.agentHooks.description',
  '@delorun/bundle-webhooks': 'plugins.pack.webhooks.description',
  '@delorun/bundle-external-agents': 'plugins.pack.externalAgents.description',
  '@delorun/bundle-computer-use-driver': 'plugins.pack.computerUseDriver.description',
}

/** How long the plugin manager may take to answer before the step says so and offers Try again. */
const SLOW_AFTER_MS = 8000

/**
 * @param waiting - whether some card still waits for its answer.
 * @returns true once the wait has lasted longer than {@link SLOW_AFTER_MS}; false again when it ends.
 */
function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!waiting) { setSlow(false); return undefined }
    const timer = setTimeout(() => { setSlow(true) }, SLOW_AFTER_MS)
    return () => { clearTimeout(timer) }
  }, [waiting])
  return slow
}

/**
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
  // The Browser pack has its own step wherever this step offers it, so it is not offered twice.
  const shown = fits(plugins.filter(name => name !== BROWSER_BUNDLE), answer, present)
  useRefresh(services, shown.map(each => each.name))
  const rowKey = optionalRows.join('\n')
  useEffect(() => { if (rowKey !== '') bundles.refreshRows(rowKey.split('\n')) }, [bundles, rowKey])
  const views = useSyncExternalStore(useCallback(listener => bundles.views.subscribe(listener), [bundles]), () => bundles.views.getSnapshot())
  const rows = useSyncExternalStore(useCallback(listener => bundles.rows.subscribe(listener), [bundles]), () => bundles.rows.getSnapshot())
  const pending = (state: string | undefined): boolean => state === undefined || state === 'checking'
  const slow = useSlow(shown.some(each => pending(views[each.name]?.state)) || optionalRows.some(id => pending(rows[id]?.state)))
  const names = new Map(keys.status === 'ready' ? keys.value.providers.map(each => [each.provider, each.name]) : [])
  const unread = answer?.plugins.some(each => each.source === 'unknown') === true && answer.registry === 'not-asked'
  const added = (state: string | undefined): boolean => state === 'installed' || state === 'restart'
  const count = shown.filter(each => added(views[each.name]?.state)).length + optionalRows.filter(id => added(rows[id]?.state)).length
  return (
    <div className={css.stack}>
      {recommendations?.status === 'failed' && <Notice tone="warning">{t('plugins.unread')}</Notice>}
      {answer?.registry === 'unreachable' && <Notice tone="warning">{t('plugins.registry.unreachable')}</Notice>}
      {slow && (
        <Notice tone="warning">{t('plugins.slow')}</Notice>
      )}
      <p className={css.lead}>{t('plugins.lead')}</p>
      {count > 0 && <p className={css.status} data-tone="done" aria-live="polite">{t('ready.plugins.count', { count: String(count) })}</p>}
      <ul className={css.cards}>
        {shown.map(({ name, matches }) => {
          const view = views[name]
          const pack = Object.hasOwn(PACK_CARDS, name) ? PACK_CARDS[name] : undefined
          return (
            <BundleCard key={name} name={name} services={services}
              title={pack !== undefined ? packTitle(name) ?? readableName(name) : view?.title !== undefined ? resolveText(view.title) : !slow && (view === undefined || view.state === 'checking') ? undefined : readableName(name)}
              description={pack !== undefined ? t(pack) : view?.description !== undefined ? resolveText(view.description) : undefined}>
              {matches.length > 0 && <StateLine tone="success">{t('plugins.fits', { names: matches.map(id => connectionName(id, t, names)).join(', ') })}</StateLine>}
            </BundleCard>
          )
        })}
        {optionalRows.map(id => <RowCard key={id} id={id} services={services} />)}
      </ul>
      <div aria-live="polite">
        {recommendations?.status === 'loading' && <p className={css.status}>{t('plugins.reading')}</p>}
        {shown.length === 0 && optionalRows.length === 0 && <p className={css.status}>{t('plugins.none')}</p>}
      </div>
      {unread && <Button variant="outline" size="sm" className={`${css.alignStart} ${css.target} ${css.inline}`} onClick={() => { guide.recommend(true) }}>{t('plugins.registry')}</Button>}
      {slow && (
        <Button variant="outline" size="sm" className={`${css.alignStart} ${css.target} ${css.inline}`}
          onClick={() => { bundles.refresh(shown.map(each => each.name)); if (optionalRows.length > 0) bundles.refreshRows(optionalRows) }}>{t('bundle.retry')}</Button>
      )}
      <button type="button" className={css.linkRow} onClick={() => { bundles.openPlugins() }}>{t('plugins.later')}</button>
    </div>
  )
}
