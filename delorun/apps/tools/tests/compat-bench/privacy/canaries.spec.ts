import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, makeCanaries, watchList } from '../../../src/compat-bench/privacy/canaries.ts'

describe('canaries', () => {
  it('are random per run and say they are fake', () => {
    const first = makeCanaries('run-1')
    const second = makeCanaries('run-1')
    expect(first.chatWord).not.toBe(second.chatWord)
    expect(first.modelKey).not.toBe(second.modelKey)
    expect(first.modelKey).toMatch(/^sk-bench-canary-/)
    for (const file of first.files) expect(file.content.toLowerCase()).toMatch(/fake/)
    expect(new Set(Object.values(first.values)).size).toBe(Object.values(first.values).length)
  })

  it('plant the four credential files and the workspace marker file at the layout\'s paths', () => {
    const canaries = makeCanaries('run-2')
    expect(canaries.files.map(file => file.path)).toEqual([
      '/home/bench/.ssh/id_ed25519', '/home/bench/.aws/credentials', '/home/bench/.config/gh/hosts.yml', '/home/bench/workspace/.env', '/home/bench/workspace/bench-marker.txt',
    ])
    expect(canaries.files.find(file => file.label === '~/.ssh/id_ed25519')?.mode).toBe(0o600)
    for (const file of canaries.files) expect(file.content).toContain(file.secret)
  })

  it('name every searchable value, none of them shared between two canaries\' files', () => {
    const canaries = makeCanaries('run-3')
    expect(Object.keys(canaries.values)).toEqual(['chat word', 'model key', '~/.ssh/id_ed25519', '~/.aws/credentials', '~/.config/gh/hosts.yml', 'workspace .env', 'workspace marker file'])
    for (const file of canaries.files) expect(canaries.values[file.label]).toBe(file.secret)
  })

  it('watch the planted files, the directories above them and Delorun\'s key store', () => {
    const watch = watchList(makeCanaries('run-4'), DEFAULT_LAYOUT)
    expect(watch.map(entry => entry.path)).toEqual(expect.arrayContaining(['/home/bench/.ssh/', '/home/bench/.aws/', '/home/bench/.config/gh/', '/home/bench/home/delorun/credentials.yaml', '/home/bench/home/delorun/secrets/', '/home/bench/.ssh/id_ed25519']))
  })

  it('honour another layout', () => {
    const layout = { userHome: '/u', workspace: '/w', delorunHome: '/d' }
    expect(makeCanaries('r', layout).files.map(file => file.path)).toContain('/w/.env')
    expect(watchList(makeCanaries('r', layout), layout).map(entry => entry.path)).toContain('/d/credentials.yaml')
  })
})
