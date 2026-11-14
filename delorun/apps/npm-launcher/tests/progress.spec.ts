/**
 * The lines the launcher prints while it installs are `@delorun/install`'s, whose own spec holds their wording.
 */
import { describe, expect, it } from 'vitest'
import * as install from '@delorun/install'
import { formatSize, progressLines } from '../src/progress.ts'

describe('the install lines', () => {
  it('are the install path\'s one copy', () => {
    expect(progressLines).toBe(install.progressLines)
    expect(formatSize).toBe(install.formatSize)
  })
})
