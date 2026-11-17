/**
 * The breakdown inside the cost dialog: Requests, New, Cached and Cost columns. New counts the tokens the provider
 * processed afresh (input, cache write and output); Cached counts the input it read back from its cache, which costs
 * less. Without agents, one row per model; with agents, one row for this chat and one per direct agent, each expanding
 * to its models. A model row expands to its four token buckets, each under its column.
 */
import { useState } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CostMeterView, CostModelRow } from '../view.ts'
import { formatCost, formatExact, formatTokens, type Translate } from './costs.ts'
import css from './CostBreakdown.module.css'

/** One top-level group of the breakdown with agents: this chat or a direct agent. */
export interface CostGroup {
  /** A key unique within the breakdown. */
  readonly id: string
  /** The name the row shows. */
  readonly name: string
  /** The group's cost. */
  readonly value: CostMeterView
}

/** Props of {@link CostBreakdown}. */
export interface CostBreakdownProps {
  /** This chat's cost, shown by model when there are no groups. */
  readonly self: CostMeterView
  /** This chat and its agents, or `null` without agents. */
  readonly groups: readonly CostGroup[] | null
  /** The dictionary. */
  readonly t: Translate
}

const BUCKETS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const

/** One row's tokens, split into the ones processed afresh and the ones read back from the provider's cache. */
interface TokenSplit {
  readonly fresh: number
  readonly cached: number
}

/** Whether every request of a value has no price. */
const allUnpriced = (value: Pick<CostModelRow, 'requests' | 'unpriced'>): boolean => value.requests > 0 && value.unpriced === value.requests

/**
 * Split the tokens of some model rows.
 * @param rows - the rows to add up.
 * @returns their new and cached tokens.
 */
export function splitTokens(rows: readonly CostModelRow[]): TokenSplit {
  let fresh = 0
  let cached = 0
  for (const row of rows) {
    fresh += row.input + row.cacheWrite + row.output
    cached += row.cacheRead
  }
  return { fresh, cached }
}

/**
 * The breakdown grid with its expandable rows.
 * @param props - the costs and the dictionary.
 * @returns the grid.
 */
export function CostBreakdown({ self, groups, t }: CostBreakdownProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  const row = (id: string, name: string, value: { requests: number; usd: number; unpriced: number } & TokenSplit, depth: number) => {
    const cost = allUnpriced(value) ? t('cost.none') : formatCost(value.usd)
    const fresh = formatTokens(value.fresh, t)
    const cached = formatTokens(value.cached, t)
    return (
      <button
        key={id}
        type="button"
        className={css.row}
        data-depth={depth}
        aria-expanded={expanded.has(id)}
        aria-label={t('row.label', { name, requests: formatExact(value.requests), fresh, cached, cost })}
        onClick={() => { toggle(id) }}
      >
        <span className={css.name}>
          <IconChevronRightOutlineRegular className={css.chevron} data-open={expanded.has(id)} aria-hidden />
          <span className={css.nameText} title={name}>{name}</span>
        </span>
        <span className={css.num}>{formatExact(value.requests)}</span>
        <span className={css.num}>{fresh}</span>
        <span className={css.num}>{cached}</span>
        <span className={allUnpriced(value) ? css.none : css.num}>{cost}</span>
      </button>
    )
  }
  const models = (prefix: string, value: CostMeterView, depth: number) => value.models.flatMap((model) => {
    const id = `${prefix}/${JSON.stringify([model.provider, model.model])}`
    return [
      row(id, model.model, { ...model, ...splitTokens([model]) }, depth),
      ...expanded.has(id) ? BUCKETS.map(bucket => (
        <div key={`${id}:${bucket}`} className={css.bucket} data-depth={depth + 1} role="group" aria-label={t('bucket.label', { name: t(`bucket.${bucket}`), tokens: formatExact(model[bucket]) })}>
          <span className={css.name}><span className={css.nameText}>{t(`bucket.${bucket}`)}</span></span>
          <span />
          {bucket === 'cacheRead' && <span />}
          <span className={css.num}>{formatExact(model[bucket])}</span>
          {bucket !== 'cacheRead' && <span />}
          <span />
        </div>
      )) : [],
    ]
  })
  return (
    <div className={css.grid}>
      <div className={css.head} aria-hidden>
        <span>{t('column.name')}</span>
        <span className={css.num}>{t('column.requests')}</span>
        <span className={css.num}>{t('column.fresh')}</span>
        <span className={css.num}>{t('column.cached')}</span>
        <span className={css.num}>{t('column.cost')}</span>
      </div>
      {groups === null
        ? models('self', self, 0)
        : groups.flatMap(group => [
            row(group.id, group.name, { ...group.value, ...splitTokens(group.value.models) }, 0),
            ...expanded.has(group.id) ? models(group.id, group.value, 1) : [],
          ])}
    </div>
  )
}
