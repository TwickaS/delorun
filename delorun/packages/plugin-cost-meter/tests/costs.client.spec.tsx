// @vitest-environment jsdom
/** The agent roll-up and the number formats. */
import { describe, expect, it } from 'vitest'
import { addCosts, collectAgents, counted, formatCost, formatExact, formatTokens, NO_COST } from '../src/client/costs.ts'
import { en, zh } from '../src/client/locales.ts'
import { agent, cost, listRow, row, sid, t } from './fixtures.client.ts'

describe('collectAgents', () => {
  it('adds each direct agent\'s own agents into its cost, costliest agent first', () => {
    const tree = collectAgents(sid('root'), [agent('a', 'Planner'), agent('b', 'Writer')], {
      [sid('a')]: listRow('a', { parentId: sid('root'), projectionValues: { costMeter: cost(row('m', 1)), subagentCatalog: [agent('a1', 'Helper')] } }),
      [sid('a1')]: listRow('a1', { parentId: sid('a'), projectionValues: { costMeter: cost(row('m', 5)) } }),
      [sid('b')]: listRow('b', { parentId: sid('root'), projectionValues: { costMeter: cost(row('n', 2)) } }),
    }, {})
    expect(tree.agents.map(entry => [entry.id, entry.label, entry.cost.usd])).toEqual([[sid('a'), 'Planner', 6], [sid('b'), 'Writer', 2]])
    expect(tree).toMatchObject({ missing: [], external: 0 })
  })

  it('finds agents through parentId when the catalog lacks them, labelled by their title', () => {
    const tree = collectAgents(sid('root'), undefined, {
      [sid('root')]: listRow('root'),
      [sid('c')]: listRow('c', { parentId: sid('root'), title: 'Reviewer', projectionValues: { costMeter: cost(row('m', 1)) } }),
      [sid('d')]: listRow('d', { parentId: sid('root'), projectionValues: { costMeter: cost(row('m', 1)) } }),
    }, {})
    expect(tree.agents.map(entry => entry.label)).toEqual(['Reviewer', 'Title d'])
  })

  it('prefers the loaded projections over the summary, lists agents with no cost on the page, and counts external agents apart', () => {
    const tree = collectAgents(sid('root'), [agent('a', 'Planner'), { id: sid('x'), createdAt: 1, mode: 'external' }, agent('gone', 'Gone')], {
      [sid('a')]: listRow('a', { projectionValues: { costMeter: cost(row('m', 1)), subagentCatalog: [{ id: sid('x2'), createdAt: 1, mode: 'external' }, agent('a', 'Loop')] } }),
    }, { [sid('a')]: { values: { costMeter: cost(row('m', 3)), subagentCatalog: [{ id: sid('x2'), createdAt: 1, mode: 'external' }] } } })
    expect(tree.agents.map(entry => [entry.id, entry.label, entry.cost.usd])).toEqual([[sid('a'), 'Planner', 3], [sid('gone'), 'Gone', 0]])
    expect(tree.missing).toEqual([sid('gone')])
    expect(tree.external).toBe(2)
  })

  it('counts an agent two parents name once, and never the open chat itself', () => {
    const tree = collectAgents(sid('root'), [agent('a', 'A'), agent('b', 'B')], {
      [sid('a')]: listRow('a', { projectionValues: { costMeter: cost(row('m', 1)), subagentCatalog: [agent('b', 'B'), agent('root', 'Root')] } }),
      [sid('b')]: listRow('b', { projectionValues: { costMeter: cost(row('m', 1)) } }),
    }, {})
    expect(addCosts(tree.agents.map(entry => entry.cost)).usd).toBe(2)
    // `a` reaches `b` before the open chat's own catalog does, so `b` counts under `a`.
    expect(tree.agents.map(entry => entry.id)).toEqual([sid('a')])
  })
})

describe('the costs', () => {
  it('add up by provider and model, keeping rows with no priced request last', () => {
    const sum = addCosts([cost(row('m', 1), row('free', 0, 2, 2)), cost(row('m', 2), row('n', 0.5))])
    expect(sum.models.map(entry => [entry.model, entry.requests, entry.usd])).toEqual([['m', 2, 3], ['n', 1, 0.5], ['free', 2, 0]])
    expect(sum).toMatchObject({ usd: 3.5, requests: 5, unpriced: 2, tokens: 5 * 1100 })
    expect(addCosts([])).toEqual(NO_COST)
  })

  it('clamp a rounding residue below zero', () => {
    expect(cost({ ...row('m', -1e-12) }).usd).toBe(0)
  })
})

describe('the formats', () => {
  it('show more decimals for small costs', () => {
    expect([formatCost(0), formatCost(0.0042), formatCost(0.123), formatCost(5.6178)]).toEqual(['$0.00', '$0.0042', '$0.123', '$5.62'])
  })

  it('shorten token counts and group exact counts', () => {
    expect([formatTokens(950, t), formatTokens(12_345, t), formatTokens(123_456, t), formatTokens(4_560_000, t)]).toEqual(['950', '12.3K', '123K', '4.6M'])
    expect(formatExact(1234567)).toBe('1,234,567')
  })

  it('word a count of one apart', () => {
    expect(counted(t, 'note.loading', 1)).toBe(en['note.loading.one'])
    expect(counted(t, 'note.external', 3)).toBe('3 external agents run outside this studio and are not counted.')
  })

  it('have every key in Chinese, without a closing full stop on the notes', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].length, key).toBeGreaterThan(0)
      expect(zh[key].endsWith('。'), key).toBe(false)
    }
  })
})
