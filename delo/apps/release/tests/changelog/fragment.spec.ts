import { describe, expect, it } from 'vitest'
import { parseFragment, SECTIONS } from '../../src/changelog/fragment.ts'

const PATH = 'delo/changelog/unreleased/upstream-lane.md'

describe('a changelog fragment', () => {
  it('parses a section and its bullet lines in the fixed section list', () => {
    expect(SECTIONS).toEqual(['Security', 'Added', 'Changed', 'Fixed', 'Removed', 'From upstream'])
    const result = parseFragment(PATH, '---\nsection: Fixed\n---\n\n- The replay no longer fails when the build is missing.\n- A second bullet.\n')
    expect(result).toEqual({
      ok: true,
      fragment: { path: PATH, section: 'Fixed', bullets: ['- The replay no longer fails when the build is missing.', '- A second bullet.'] },
    })
  })

  it('accepts a quoted section name', () => {
    expect(parseFragment(PATH, '---\nsection: "From upstream"\n---\n\n- A change.\n')).toMatchObject({ ok: true, fragment: { section: 'From upstream' } })
  })

  it('names each violation of the front matter, the section, the body and the file name', () => {
    expect(parseFragment(PATH, '---\nsection: Bogus\n---\n\n- A change.\n')).toEqual({
      ok: false,
      errors: ['section "Bogus" is not one of Security, Added, Changed, Fixed, Removed, From upstream'],
    })
    expect(parseFragment(PATH, '# No front matter\n\n- A change.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('does not open with `---`')] })
    expect(parseFragment(PATH, '---\nsection: Fixed\ntype: Fixed\n---\n\n- A change.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('exactly one `section:`')] })
    expect(parseFragment(PATH, '---\nsection: Fixed\n---\n\nA sentence without a bullet.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('is not a bullet')] })
    expect(parseFragment(PATH, '---\nsection: Fixed\n---\n\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('no bullet line')] })
    expect(parseFragment('delo/changelog/unreleased/Upstream_Lane.md', '---\nsection: Fixed\n---\n\n- A change.\n')).toMatchObject({ ok: false, errors: [expect.stringContaining('lowercase')] })
  })

  it('refuses internal identifiers in the body', () => {
    for (const bullet of ['- Fixed in #412.', '- Done in WP1.11.', '- Per decision D12.']) {
      expect(parseFragment(PATH, `---\nsection: Fixed\n---\n\n${bullet}\n`)).toMatchObject({ ok: false, errors: [expect.stringContaining('names')] })
    }
  })
})
