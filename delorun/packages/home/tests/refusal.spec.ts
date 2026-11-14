/**
 * The refusal format every Delorun command-line program shares: the lead, `Why:` and `What you can do:` lines through the
 * program's redactor, the first matching describer, the plain report of anything no describer names, and how a refused
 * home reads.
 */
import { describe, expect, it } from 'vitest'
import { codedReason, describeFailure, HomeLayoutError, homeLayoutDescriber, profileOption, refusalDescriber, renderRefusal } from '../src/index.ts'

class BaseFailure extends Error {}
class SubFailure extends BaseFailure {}

/** A redactor that changes nothing, for the specs of the format itself. */
const KEEP = { text: (text: string): string => text }

/** A redactor that replaces the one secret these specs use, as `@delorun/logs`'s redactor replaces a provider key. */
const SECRET = ['sk', '0123456789abcdef0123456789abcdef'].join('-')
const MARK = { text: (text: string): string => text.replaceAll(SECRET, '[redacted:provider-key]') }

describe('a refusal', () => {
  it('renders the lead, the reason and one indented line per remedy', () => {
    expect(renderRefusal({ lead: 'Delorun did a thing.', reason: 'CODE: the detail', remedies: ['Do this.', 'Or that.'] }, KEEP)).toBe('Delorun did a thing.\nWhy: CODE: the detail\nWhat you can do:\n  Do this.\n  Or that.\n')
    expect(renderRefusal({ lead: 'Delorun did a thing.', remedies: [] }, KEEP)).toBe('Delorun did a thing.\n')
  })

  it('passes the lead, the reason and every remedy through the redactor', () => {
    const text = renderRefusal({ lead: `lead ${SECRET}`, reason: `reason ${SECRET}`, remedies: [`remedy ${SECRET}`] }, MARK)
    expect(text).toBe('lead [redacted:provider-key]\nWhy: reason [redacted:provider-key]\nWhat you can do:\n  remedy [redacted:provider-key]\n')
    expect(renderRefusal(describeFailure(new Error(`the key ${SECRET} was refused`), []), MARK)).toBe('Delorun stopped: the key [redacted:provider-key] was refused\n')
  })

  it('is described by the first describer whose class the error is an instance of', () => {
    const base = refusalDescriber(BaseFailure, () => ({ lead: 'base', remedies: [] }))
    const sub = refusalDescriber(SubFailure, () => ({ lead: 'sub', remedies: [] }))
    expect(describeFailure(new SubFailure('x'), [sub, base]).lead).toBe('sub')
    expect(describeFailure(new SubFailure('x'), [base, sub]).lead).toBe('base')
    expect(describeFailure(new BaseFailure('x'), [sub, base]).lead).toBe('base')
  })

  it('reports any other value with its message, no stack and no remedy', () => {
    expect(describeFailure(new TypeError('x is undefined'), [homeLayoutDescriber])).toEqual({ lead: 'Delorun stopped: x is undefined', remedies: [] })
    expect(describeFailure('plain text', [])).toEqual({ lead: 'Delorun stopped: plain text', remedies: [] })
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
    expect(renderRefusal(describeFailure(error, [homeLayoutDescriber]), KEEP)).toBe('Delorun stopped before using /h/secrets/key.\nWhy: SECRET_FILE_MODE: /h/secrets/key has mode 0644\nWhat you can do:\n  Fix it with: chmod 600 /h/secrets/key\n')
  })

  it('offers nothing when no fix exists', () => {
    expect(describeFailure(new HomeLayoutError('HOME_INVALID', 'relative', 'the home is not absolute'), [homeLayoutDescriber])).toEqual({ lead: 'Delorun stopped before using relative.', reason: 'HOME_INVALID: the home is not absolute', remedies: [] })
  })
})
