/**
 * What the launcher draws while it installs is `@delorun/install`'s one renderer, whose own spec holds its wording.
 */
import { describe, expect, it } from 'vitest'
import * as install from '@delorun/install'
import { createRenderer, formatSize, InstallRenderer } from '../src/progress.ts'

describe('the install display', () => {
  it('is the install path\'s one renderer', () => {
    expect(createRenderer).toBe(install.createRenderer)
    expect(InstallRenderer).toBe(install.InstallRenderer)
    expect(formatSize).toBe(install.formatSize)
  })
})
