/**
 * The refusal format every Delo command-line program shares: the lead, `Why:` and `What you can do:` lines, the first
 * matching describer, the plain report of anything no describer names, and how a refused home reads.
 */
import { describe, expect, it } from 'vitest'
import { codedReason, describeFailure, HomeLayoutError, homeLayoutDescriber, profileOption, refusalDescriber, renderRefusal } from '../src/index.ts'

class BaseFailure extends Error {}
class SubFailure extends BaseFailure {}

describe('a refusal', () => {
  it('renders the lead, the reason and one indented line per remedy', () => {
    expect(renderRefusal({ lead: 'Delo did a thing.', reason: 'CODE: the detail', remedies: ['Do this.', 'Or that.'] })).toBe('Delo did a thing.\nWhy: CODE: the detail\nWhat you can do:\n  Do this.\n  Or that.\n')
    expect(renderRefusal({ lead: 'Delo did a thing.', remedies: [] })).toBe('Delo did a thing.\n')
  })

  it('is described by the first describer whose class the error is an instance of', () => {
    const base = refusalDescriber(BaseFailure, () => ({ lead: 'base', remedies: [] }))
    const sub = refusalDescriber(SubFailure, () => ({ lead: 'sub', remedies: [] }))
    expect(describeFailure(new SubFailure('x'), [sub, base]).lead).toBe('sub')
    expect(describeFailure(new SubFailure('x'), [base, sub]).lead).toBe('base')
    expect(describeFailure(new BaseFailure('x'), [sub, base]).lead).toBe('base')
  })

  it('reports any other value with its message, no stack and no remedy', () => {
    expect(describeFailure(new TypeError('x is undefined'), [homeLayoutDescriber])).toEqual({ lead: 'Delo stopped: x is undefined', remedies: [] })
    expect(describeFailure('plain text', [])).toEqual({ lead: 'Delo stopped: plain text', remedies: [] })
  })

  it('names the profile in a remedy only when the context names one, and the code before a detail', () => {
    expect(profileOption({ profile: 'work' })).toBe(' --profile work')
    expect(profileOption({})).toBe('')
    expect(codedReason('CODE', 'the detail')).toBe('CODE: the detail')
    expect(codedReason('CODE', undefined)).toBe('CODE')
  })
})

describe('a refused home', () => {
  it('names the path, C1\'s code with the detail, and the fix', () => {
    const error = new HomeLayoutError('SECRET_FILE_MODE', '/h/secrets/key', '/h/secrets/key has mode 0644', 'chmod 600 /h/secrets/key')
    expect(error.message).toBe('SECRET_FILE_MODE: /h/secrets/key has mode 0644; fix it with: chmod 600 /h/secrets/key')
    expect(renderRefusal(describeFailure(error, [homeLayoutDescriber]))).toBe('Delo stopped before using /h/secrets/key.\nWhy: SECRET_FILE_MODE: /h/secrets/key has mode 0644\nWhat you can do:\n  Fix it with: chmod 600 /h/secrets/key\n')
  })

  it('offers nothing when no fix exists', () => {
    expect(describeFailure(new HomeLayoutError('HOME_INVALID', 'relative', 'the home is not absolute'), [homeLayoutDescriber])).toEqual({ lead: 'Delo stopped before using relative.', reason: 'HOME_INVALID: the home is not absolute', remedies: [] })
  })
})
