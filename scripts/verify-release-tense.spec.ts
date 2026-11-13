import { describe, expect, it } from 'vitest'
import { findReleaseTenseViolations, isReleaseTenseFile } from './verify-release-tense.ts'

describe('release-status policy', () => {
  it('accepts present-tense text', () => {
    const source = [
      '# Install',
      '',
      'Delorun does not include a desktop app ([Roadmap and vision](roadmap.md)).',
      'macOS is not supported. Since 0.1.0 the launcher checks the release log.',
    ].join('\n')

    expect(findReleaseTenseViolations('delo/docs/guide/install.md', source)).toEqual([])
  })

  it('names the file, line and phrase of each release-status phrase, whatever its case', () => {
    const source = [
      '# Logs',
      'Delorun has No Release Yet; this page describes the First Release.',
      'Docker workspaces are not available yet.',
      'Relay: COMING SOON.',
      'It is not yet released and has not been released.',
      'Wait until the launch, or until release; stay off before 0.1.0 and before the public release.',
    ].join('\n')

    expect(findReleaseTenseViolations('delo/docs/guide/logs.md', source).map(({ line, phrase }) => [line, phrase])).toEqual([
      [2, 'No Release Yet'],
      [2, 'First Release'],
      [3, 'not available yet'],
      [4, 'COMING SOON'],
      [5, 'not yet released'],
      [5, 'has not been released'],
      [6, 'until the launch'],
      [6, 'until release'],
      [6, 'before 0.1.0'],
      [6, 'before the public release'],
    ])
  })

  it.each([
    'delo/docs/guide/roadmap.md',
    'delo/docs/plans/v5-rc-final-plan.md',
    'delo/changelog/0.1.0/entry.md',
    'delo/docs/guide/install.zh.md',
    'docs/guide/install.md',
    'delo/docs/guide/meta.json',
  ])('skips %s', (file) => {
    expect(isReleaseTenseFile(file)).toBe(false)
    expect(findReleaseTenseViolations(file, 'This has no release yet and is coming soon.')).toEqual([])
  })

  it('checks English Markdown anywhere else under delo', () => {
    expect(isReleaseTenseFile('delo/docs/contracts/c02-release-manifest.md')).toBe(true)
    expect(isReleaseTenseFile('delo/packages/bundle-local/README.md')).toBe(true)
  })
})
