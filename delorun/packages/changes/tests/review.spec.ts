import { describe, expect, it, vi } from 'vitest'
import { BUILT_IN_CHECKS } from '../src/risk.ts'
import { LOCATIONS_PER_LINE, NOTHING_FOUND, RISK_NOTICE, reviewChange, riskLines } from '../src/review.ts'
import { RISK_KINDS, type RiskCheck, type RiskFinding, type RiskKind } from '../src/types.ts'

// The cases write real files and git histories; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

function finding(kind: RiskKind, file: string, line?: number, check = 'test', excerpt = 'x'): RiskFinding {
  return line === undefined ? { kind, check, file, excerpt } : { kind, check, file, line, excerpt }
}

function returning(id: string, findings: readonly RiskFinding[]): RiskCheck {
  return { id, check: () => findings }
}

describe('reviewChange', () => {
  it('finds nothing and asks no second confirmation when no check matches', () => {
    expect(reviewChange({ files: [] })).toEqual({ findings: [], kinds: [], needsSecondConfirmation: false })
  })

  it('runs the built-in checks by default', () => {
    const summary = reviewChange({ files: [{ path: 'src/index.ts', status: 'added', dependency: false, after: "ctx.tools.register(tool)\nawait fetch('https://example.com')" }] })
    expect(summary.kinds).toEqual(['model-tool', 'network'])
    expect(summary.needsSecondConfirmation).toBe(true)
  })

  it('sorts findings by kind, file, line, check and excerpt, and keeps identical ones once', () => {
    const late = returning('late', [
      finding('network', 'b.ts', 2),
      finding('model-tool', 'b.ts', 1),
      finding('network', 'a.ts', 9),
      finding('network', 'a.ts'),
      finding('network', 'a.ts', 9, 'test', 'w'),
      finding('network', 'a.ts', 9, 'other'),
    ])
    const early = returning('early', [finding('network', 'b.ts', 2), finding('consent-guard-sandbox', 'z.ts', 4)])
    const summary = reviewChange({ files: [] }, [late, early])
    expect(summary.findings).toEqual([
      finding('consent-guard-sandbox', 'z.ts', 4),
      finding('model-tool', 'b.ts', 1),
      finding('network', 'a.ts'),
      finding('network', 'a.ts', 9, 'other'),
      finding('network', 'a.ts', 9, 'test', 'w'),
      finding('network', 'a.ts', 9),
      finding('network', 'b.ts', 2),
    ])
    expect(summary.kinds).toEqual(['consent-guard-sandbox', 'model-tool', 'network'])
  })

  it('runs checks passed after the built-in ones', () => {
    const registered = returning('registered', [finding('home-read', 'src/x.ts', 1, 'registered')])
    const summary = reviewChange({ files: [{ path: 'src/x.ts', status: 'added', dependency: false, after: 'fetch(url)' }] }, [...BUILT_IN_CHECKS, registered])
    expect(summary.findings.map(item => item.check)).toEqual(['built-in:network', 'registered'])
  })
})

describe('riskLines', () => {
  it('says nothing matched under the fixed first line', () => {
    expect(riskLines(reviewChange({ files: [] }))).toEqual([RISK_NOTICE, NOTHING_FOUND])
    expect(RISK_NOTICE).toBe("This summary is a help to read the change, not a protection: a plugin's code can do anything Delorun can.")
  })

  it('prints one line per kind with at most three distinct locations', () => {
    const summary = reviewChange({ files: [] }, [returning('t', [
      finding('model-tool', 'src/index.ts', 12),
      finding('network', 'a.ts', 1),
      finding('network', 'a.ts', 1, 'other'),
      finding('network', 'b.ts', 2),
      finding('network', 'c.ts', 3),
      finding('network', 'd.ts', 4),
      finding('network', 'e.ts', 5),
      finding('dependency-or-build', 'node_modules/x'),
    ])])
    expect(riskLines(summary)).toEqual([
      RISK_NOTICE,
      'Adds a tool the model can call (src/index.ts:12)',
      'Opens network connections (a.ts:1, b.ts:2, c.ts:3 and 2 more)',
      'Adds or changes a dependency, or an install or build script (node_modules/x)',
    ])
    expect(LOCATIONS_PER_LINE).toBe(3)
  })

  it('names every kind in plain words without the words the product avoids', () => {
    const summary = reviewChange({ files: [] }, [returning('t', RISK_KINDS.map(kind => finding(kind, 'f.ts', 1)))])
    const lines = riskLines(summary)
    expect(lines).toHaveLength(RISK_KINDS.length + 1)
    for (const line of lines) expect(line).not.toMatch(/integrity|trust|drift/i)
  })
})
