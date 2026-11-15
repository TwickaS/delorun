/** The studio profile opens upstream's content index, so the sidebar can search inside chats. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestHome, DELORUN_PROFILE, type TestHome } from './profiles.ts'

let home: TestHome
beforeAll(() => { home = createTestHome() })
afterAll(() => { home.remove() })

describe('the studio profile\'s message search', () => {
  it('opens the session-query index on the first search instead of leaving it closed', () => {
    const row = home.rows(DELORUN_PROFILE).find(entry => entry.id === 'session-query-sqlite')
    expect(row?.name).toBe('@deepseek-ai/dsh-session-query-sqlite')
    expect(row?.disabled).not.toBe(true)
    expect(row?.config).toMatchObject({ openAt: 'first-search' })
  })

  it('keeps the index in memory, so no copy of chat text is left in the home', () => {
    const row = home.rows(DELORUN_PROFILE).find(entry => entry.id === 'session-query-sqlite')
    expect(row?.config).toMatchObject({ path: ':memory:' })
  })
})
