/**
 * The launcher's judgement of bundle layers that the MCP consent reads at each review (A631, L201): a pack only when
 * the layer loads from the folder the running release installs that pack in, or from the profile's Changes review copy
 * of that folder; a pack's name on a bundle anywhere else is `other`; Delorun's runtime bundles are `runtime`. Each
 * call reads the folders and the approved record as they are then.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeDirectory } from '@delorun/changes'
import { LOCAL_BUNDLE } from '@delorun/bundle-local/profile'
import { packLayersOf } from '../src/compose.ts'

const PACK = '@delorun/bundle-webhooks'
let root: string
let home: string
let profileDir: string
let folder: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-pack-layers-')))
  home = join(root, 'home')
  profileDir = join(home, 'profiles', 'default')
  folder = join(home, 'packs', '0.1.0', '@delorun__bundle-webhooks', 'package')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: PACK, version: '0.1.0' }))
  symlinkSync('0.1.0', join(home, 'packs', 'current'))
  writeApprovedSource(undefined)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Write the profile's manifest, approving the pack from a source, or approving nothing.
 * @param source - the approved source of the pack, or undefined.
 */
function writeApprovedSource(source: string | undefined): void {
  mkdirSync(profileDir, { recursive: true })
  const plugins = source === undefined ? {} : { [PACK]: { source, version: 'a'.repeat(64), approvedAt: '2026-11-23T09:30:00.000Z' } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'default', private: true, dsh: { profile: { bundles: [PACK] } }, delorun: { changes: { schema: 'delorun.changes-approved/1', plugins } } }))
}

/**
 * The judge for a release that lists the pack in its folder through `packs/current`.
 * @returns the judge.
 */
function judge(): ReturnType<typeof packLayersOf> {
  return packLayersOf({ home, profile: 'default' }, profileDir, new Map([[PACK, join(home, 'packs', 'current', '@delorun__bundle-webhooks', 'package')]]))
}

describe('the pack layers judge', () => {
  it('takes a layer in the release\'s pack folder as a pack, directly or through a link', async () => {
    expect(await judge().kindOf({ packageName: PACK, packageDir: folder })).toBe('pack')
    const link = join(root, 'link')
    symlinkSync(folder, link)
    expect(await judge().kindOf({ packageName: PACK, packageDir: link })).toBe('pack')
  })

  it('takes a pack-named bundle outside the release\'s pack folder as a third party\'s, not a pack', async () => {
    const elsewhere = join(root, 'elsewhere', 'bundle-webhooks')
    cpSync(folder, elsewhere, { recursive: true })
    expect(await judge().kindOf({ packageName: PACK, packageDir: elsewhere })).toBe('other')
    // Nor a review copy approved from that other folder.
    const active = activeDirectory(home, 'default', PACK)
    cpSync(folder, active, { recursive: true })
    writeApprovedSource(elsewhere)
    expect(await judge().kindOf({ packageName: PACK, packageDir: active })).toBe('other')
    // Nor a bundle in the pack's folder under another name.
    expect(await judge().kindOf({ packageName: '@delorun/bundle-other', packageDir: folder })).toBe('other')
  })

  it('reads the approved record at each call, so a review copy counts once approved from the pack\'s folder', async () => {
    const active = activeDirectory(home, 'default', PACK)
    cpSync(folder, active, { recursive: true })
    const packs = judge()
    expect(await packs.kindOf({ packageName: PACK, packageDir: active })).toBe('other')
    writeApprovedSource(join(home, 'packs', 'current', '@delorun__bundle-webhooks', 'package'))
    expect(await packs.kindOf({ packageName: PACK, packageDir: active })).toBe('pack')
  })

  it('takes Delorun\'s runtime bundles as runtime and any other bundle as a third party\'s', async () => {
    expect(await judge().kindOf({ packageName: LOCAL_BUNDLE, packageDir: join(root, 'anywhere') })).toBe('runtime')
    expect(await judge().kindOf({ packageName: 'evil-bundle', packageDir: join(root, 'anywhere') })).toBe('other')
  })
})
