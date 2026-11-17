/**
 * STAND-IN, hand-made: "every change is one step", the session of Changes and Setup versions. Two changes to two
 * plugins are listed; one is undone and the other stays; Setup versions lists saved setups; `delorun logs` shows the
 * log. Stage 3 replaces this file with a fixture made from a real run on the opening candidate. The Changes and Setup
 * versions data are typed by the product's own wire types, so a change to them fails the website's type check.
 * @module @delorun/website/replica/sessions/changes-and-versions.fixture
 */
import type { ReplicaFixture } from '../model.ts'
import type { EntryView } from '../../../../../packages/plugin-changes/src/wire.ts'

const THEME: EntryView = {
  id: 'chg-2', kind: 'plugin-edit', state: 'applied', summary: 'Changed the settings of delorun-theme', plugin: 'delorun-theme',
  createdAt: '2026-11-17T10:42:00Z', decidedAt: '2026-11-17T10:42:00Z', decidedFrom: 'unreviewed', undoable: true,
}
const WORD_COUNT: EntryView = {
  id: 'chg-1', kind: 'plugin-install', state: 'applied', summary: 'Added the plugin word-count', plugin: 'word-count',
  createdAt: '2026-11-17T09:31:00Z', decidedAt: '2026-11-17T09:33:00Z', decidedFrom: 'studio', undoable: true,
}
const BASE = { atComputer: true, profile: 'default', protection: 'off', leftOut: [], folders: [], requests: [], harness: [], problems: [] } as const

/** The session. */
export const FIXTURE: ReplicaFixture = {
  id: 'changes-and-versions',
  standIn: true,
  release: '0.1.0-preview.2',
  clock: '2026-11-17T10:50:00Z',
  events: [],
  changes: {
    two: { ...BASE, recent: [THEME, WORD_COUNT] },
    undone: { ...BASE, recent: [{ ...THEME, state: 'undone', decidedAt: '2026-11-17T10:50:00Z', undoable: false }, WORD_COUNT] },
  },
  versions: {
    list: {
      unsaved: false,
      versions: [
        { id: 'v4', at: Date.UTC(2026, 10, 17, 10, 50), summary: 'Changed the settings of delorun-theme', origin: 'other', current: true },
        { id: 'v3', at: Date.UTC(2026, 10, 17, 9, 33), summary: 'Added the plugin word-count', origin: 'other', current: false },
        { id: 'v2', at: Date.UTC(2026, 10, 16, 18, 2), summary: 'saved', origin: 'saved', name: 'Before trying new plugins', current: false },
        { id: 'v1', at: Date.UTC(2026, 10, 14, 9, 15), summary: 'update', origin: 'update', current: false },
      ],
    },
  },
  versionChanges: {
    plugins: [{ name: 'word-count', from: '0.1.0' }], bundles: [], exemptions: [], builds: [],
    patchChanged: true, homePatchChanged: false, lockfileChanged: false, disabled: [], same: false,
  },
}
