/** The version list merges identical consecutive edits and names the plugin in plain words. */
import { describe, expect, it } from 'vitest'
import { groupVersions, settingsEditName } from '../src/client/version-rows.ts'
import type { VersionEntry } from '../src/client/versions-api.ts'

function version(id: string, summary: string, origin: VersionEntry['origin'] = 'other'): VersionEntry {
  return { id, at: 0, summary, origin, current: false }
}

describe('groupVersions', () => {
  it('merges consecutive identical rows into the newest, with a count', () => {
    const groups = groupVersions([version('c', 'Changed the settings of delorun-onboarding'), version('b', 'Changed the settings of delorun-onboarding'), version('a', 'Changed the settings of delorun-onboarding')])
    expect(groups).toEqual([{ version: expect.objectContaining({ id: 'c' }), count: 3 }])
  })

  it('keeps a different row between two identical ones apart', () => {
    const groups = groupVersions([version('c', 'x'), version('b', 'y'), version('a', 'x')])
    expect(groups.map(group => group.count)).toEqual([1, 1, 1])
  })

  it('never merges versions the person saved', () => {
    expect(groupVersions([version('b', 'Saved', 'saved'), version('a', 'Saved', 'saved')])).toHaveLength(2)
  })
})

describe('settingsEditName', () => {
  it('shows the row as words rather than its id', () => {
    expect(settingsEditName('Changed the settings of delorun-onboarding')).toBe('Onboarding')
    expect(settingsEditName('Changed the settings of delorun-theme')).toBe('Theme')
  })
  it('leaves other summaries alone', () => {
    expect(settingsEditName('Saved before an update')).toBeUndefined()
  })
})
