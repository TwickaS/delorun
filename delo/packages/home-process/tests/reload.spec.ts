/**
 * `changes.reload` is the person's: the Host's token, which acts for reach sessions, is refused before the Host reloads.
 */
import { describe, expect, it, vi } from 'vitest'
import { reloadChanges } from '../src/reload.ts'

describe('changes.reload caller rule', () => {
  it('refuses the Host\'s token without reloading', async () => {
    const reload = vi.fn(async () => ({ ok: true as const }))
    await expect(reloadChanges('host', reload)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads for the person', async () => {
    const reload = vi.fn(async () => ({ ok: true as const }))
    await expect(reloadChanges('person', reload)).resolves.toEqual({ reload: { ok: true } })
  })
})
