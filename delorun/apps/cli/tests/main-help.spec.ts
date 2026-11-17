import { describe, expect, it } from 'vitest'
import { HELP_GROUPS, HELP_WIDTH_LIMIT, mainHelp, wrapWithHangingIndent } from '../src/main-help.ts'
import { createStyle } from '../src/style.ts'
import { COMMANDS } from '../src/main.ts'

const PLAIN = createStyle({ env: {}, isTTY: false, platform: 'linux' })
const NAMES = COMMANDS.map(command => command.name)

describe('the main help', () => {
  it('groups every command of the table once', () => {
    expect(HELP_GROUPS.flatMap(([, entries]) => entries.map(([name]) => name)).sort()).toEqual([...NAMES].sort())
  })

  it('refuses a table whose commands and groups differ', () => {
    expect(() => mainHelp({ commands: [...NAMES, 'newcomer'], version: '1', columns: 80, style: PLAIN })).toThrow('newcomer has no group')
    expect(() => mainHelp({ commands: NAMES.filter(name => name !== 'doctor'), version: '1', columns: 80, style: PLAIN })).toThrow('doctor is not a command')
  })

  it('wraps at the terminal width, and never past 88, with the continuation under the text', () => {
    for (const columns of [60, 80, 200]) {
      const lines = mainHelp({ commands: NAMES, version: '0.1.0', columns, style: PLAIN }).split('\n')
      expect(Math.max(...lines.map(line => line.length)), String(columns)).toBeLessThanOrEqual(Math.min(columns, HELP_WIDTH_LIMIT))
    }
    const narrow = mainHelp({ commands: NAMES, version: '0.1.0', columns: 50, style: PLAIN })
    expect(narrow).toContain('  reach        use the studio from your phone,\n               over your own Tailscale network')
  })

  it('starts with the badge, the version and what Delorun is, in colour only when asked', () => {
    const plain = mainHelp({ commands: NAMES, version: '0.1.0', columns: 80, style: PLAIN })
    expect(plain.split('\n')[0]).toBe('delorun 0.1.0 · the studio on your computer')
    expect(plain).not.toContain('\u001b[')
    const coloured = mainHelp({ commands: NAMES, version: '0.1.0', columns: 80, style: createStyle({ env: { FORCE_COLOR: '1' }, isTTY: false, platform: 'linux' }) })
    expect(coloured.split('\n')[0]).toContain('\u001b[38;5;208m')
  })

  it('wraps one paragraph on a hanging indent', () => {
    expect(wrapWithHangingIndent('  word  ', 'one two three four five', 18)).toEqual(['  word  one two', '        three four', '        five'])
    expect(wrapWithHangingIndent('', '', 10)).toEqual([''])
  })
})
