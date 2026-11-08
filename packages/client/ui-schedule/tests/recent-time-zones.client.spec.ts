// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPersistenceHostId } from '@deepseek-ai/dsh-client-store'
import { loadRecentTimeZones, rememberTimeZone } from '../src/client/recent-time-zones.ts'

afterEach(() => {
  setPersistenceHostId(undefined)
  localStorage.clear()
})

describe('recent time zones', () => {
  it('seeds the device zone and UTC without inferring location from language', () => {
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])
    expect(loadRecentTimeZones('UTC')).toEqual(['UTC'])
  })

  it('promotes exact IANA ids, de-duplicates them, and keeps five', () => {
    let recent: readonly string[] = ['UTC']
    for (const zone of ['Asia/Shanghai', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Africa/Lagos', 'UTC']) {
      recent = rememberTimeZone(recent, zone)
    }
    expect(recent).toEqual(['UTC', 'Africa/Lagos', 'Asia/Tokyo', 'America/New_York', 'Europe/Berlin'])
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(recent)
  })

  it('falls back safely when persisted data is invalid', () => {
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '{')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
  })

  it('falls back when persisted data is not an array or holds no usable zone', () => {
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '42')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', '["", 7]')
    expect(loadRecentTimeZones('Europe/Paris')).toEqual(['Europe/Paris', 'UTC'])
  })

  it('seeds and promotes without browser storage', () => {
    // A browser that denies storage (private mode, a locked-down embed) must
    // still offer the first-run seed and keep promoting in memory.
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])
      expect(rememberTimeZone(['Europe/Berlin', 'UTC'], 'Asia/Tokyo'))
        .toEqual(['Asia/Tokyo', 'Europe/Berlin', 'UTC'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists per connection under the host id and leaves stock entries unread', () => {
    const hostA = '0b9e8c52-6a17-4b8e-9a2f-1d3c5e7f9a01'
    const hostB = 'c2f4a6d8-3e50-4f19-b7a2-8c0e2d4b6f83'
    setPersistenceHostId(hostA)

    const recent = rememberTimeZone(['UTC'], 'Asia/Tokyo')
    expect(localStorage.getItem(`dsh.schedule.recent-time-zones.v1.${hostA}`)).toBe(JSON.stringify(recent))
    expect(localStorage.getItem('dsh.schedule.recent-time-zones.v1')).toBeNull()
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(recent)

    // Another connection sharing one browser origin reads none of this state.
    setPersistenceHostId(hostB)
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])

    // A stock entry written without a host id is not migrated: it is not read.
    localStorage.setItem('dsh.schedule.recent-time-zones.v1', JSON.stringify(['Europe/Berlin']))
    expect(loadRecentTimeZones('Asia/Shanghai')).toEqual(['Asia/Shanghai', 'UTC'])
  })
})
