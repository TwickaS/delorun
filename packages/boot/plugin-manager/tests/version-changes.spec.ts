/** What putting the profile back as a history version changes, read from the files on both sides. */
import { expect, it } from 'vitest'
import { broughtBack, profileVersionChanges } from '../src/version-changes.ts'

function files(entries: Record<string, string | undefined>): Map<string, string | undefined> {
  return new Map(Object.entries(entries))
}

const manifest = (dependencies: Record<string, unknown> | undefined, bundles?: unknown) =>
  JSON.stringify({ name: 'profile', ...dependencies === undefined ? {} : { dependencies }, ...bundles === undefined ? {} : { dsh: { profile: { bundles } } } })

it('lists the dependencies, bundles, build decisions and exemptions a version changes', () => {
  const now = files({
    'package.json': manifest({ kept: '1.0.0', moved: '2.0.0', gone: '1.0.0' }, ['kept', 'gone']),
    'pnpm-workspace.yaml': 'packages:\n  - .\nallowBuilds:\n  same: true\n  flipped: true\n  dropped: false\n',
    'compatibility.json': JSON.stringify({ 'kept@1.0.0': ['0.2.0', '0.2.1'] }),
    'cordis.patch.yml': '[]\n',
  })
  const then = files({
    'package.json': manifest({ kept: '1.0.0', moved: '1.0.0', back: '3.0.0' }, ['kept', 'back']),
    'pnpm-workspace.yaml': 'packages:\n  - .\nallowBuilds:\n  same: true\n  flipped: false\n  waiting: set this to true or false\n',
    'compatibility.json': JSON.stringify({ 'kept@1.0.0': ['0.2.0'], 'back@3.0.0': ['0.2.1'] }),
    'cordis.patch.yml': '- id: row\n  disabled: true\n',
  })
  expect(profileVersionChanges(now, then)).toEqual({
    plugins: [
      { name: 'back', change: 'added', to: '3.0.0' },
      { name: 'gone', change: 'removed', from: '1.0.0' },
      { name: 'moved', change: 'version', from: '2.0.0', to: '1.0.0' },
    ],
    bundles: [{ name: 'back', selected: true }, { name: 'gone', selected: false }],
    builds: [
      { name: 'dropped', from: 'denied' },
      { name: 'flipped', from: 'allowed', to: 'denied' },
      { name: 'waiting', to: 'pending' },
    ],
    exemptions: [
      { packageVersion: 'back@3.0.0', runtimeVersion: '0.2.1', change: 'added' },
      { packageVersion: 'kept@1.0.0', runtimeVersion: '0.2.1', change: 'removed' },
    ],
    patchChanged: true,
    homePatchChanged: false,
    unreadable: [],
  })
})

it('names the packages a version brings back: each one it adds or moves, and each bundle it selects', () => {
  expect(broughtBack({
    plugins: [{ name: 'back', change: 'added', to: '3.0.0' }, { name: 'gone', change: 'removed', from: '1.0.0' }, { name: 'moved', change: 'version', from: '2.0.0', to: '1.0.0' }],
    bundles: [{ name: 'back', selected: true }, { name: 'shipped', selected: true }, { name: 'gone', selected: false }],
    builds: [], exemptions: [], patchChanged: false, homePatchChanged: false, unreadable: [],
  })).toEqual(['back', 'moved', 'shipped'])
})

it('reads absent files as empty and ignores values that are not the records it expects', () => {
  const changes = profileVersionChanges(files({}), files({
    'package.json': JSON.stringify({ dependencies: { valid: '1.0.0', invalid: 2 }, dsh: { profile: { bundles: ['valid', 3] } } }),
    'pnpm-workspace.yaml': 'allowBuilds:\n  odd: maybe\n',
    'compatibility.json': JSON.stringify({ 'valid@1.0.0': ['0.2.0', 4], 'other@1.0.0': 'not a list' }),
  }))
  expect(changes).toEqual({
    plugins: [{ name: 'valid', change: 'added', to: '1.0.0' }], bundles: [{ name: 'valid', selected: true }],
    builds: [], exemptions: [{ packageVersion: 'valid@1.0.0', runtimeVersion: '0.2.0', change: 'added' }],
    patchChanged: false, homePatchChanged: false, unreadable: [],
  })
  expect(profileVersionChanges(files({ 'package.json': '[]', 'compatibility.json': '"text"', 'pnpm-workspace.yaml': 'allowBuilds: [a]\n' }), files({
    'package.json': JSON.stringify({ dependencies: [], dsh: { profile: { bundles: 'one' } } }),
  }))).toEqual({ plugins: [], bundles: [], builds: [], exemptions: [], patchChanged: false, homePatchChanged: false, unreadable: [] })
})

it('names a file it cannot parse on either side and lists no change from it', () => {
  expect(profileVersionChanges(files({
    'package.json': '{not json', 'pnpm-workspace.yaml': 'allowBuilds:\n  a: true\n',
  }), files({
    'package.json': manifest({ back: '1.0.0' }), 'pnpm-workspace.yaml': 'allowBuilds: [unclosed\n', 'compatibility.json': '{',
  }))).toEqual({ plugins: [], bundles: [], builds: [], exemptions: [], patchChanged: false, homePatchChanged: false, unreadable: ['package.json', 'pnpm-workspace.yaml', 'compatibility.json'] })
})
