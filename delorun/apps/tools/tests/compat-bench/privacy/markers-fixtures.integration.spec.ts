import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runWithHooks } from '../../../src/compat-bench/privacy/harness.ts'
import type { HookedRun } from '../../../src/compat-bench/privacy/harness.ts'
import { buildPrivacy } from '../../../src/compat-bench/privacy/markers.ts'
import { assemble } from '../../../src/compat-bench/privacy/observed.ts'
import { MARKER_KEYS } from '../../../src/compat-bench/privacy/types.ts'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

let baseline: HookedRun
beforeAll(async () => { baseline = await runWithHooks(fixture('ordinary.mjs')) })

/** Run a fixture and turn what the hooks saw, less the ordinary plugin's baseline, into markers. */
async function markersFor(name: string, options: Parameters<typeof runWithHooks>[1] = {}, declared: Parameters<typeof buildPrivacy>[1] = {}) {
  const run = await runWithHooks(fixture(name), options)
  expect(run.status).toBe(0)
  return buildPrivacy(assemble({ hooks: run.summary, fileChanges: [], leftCanaries: [] }, { hooks: baseline.summary, fileChanges: [], leftCanaries: [] }), declared)
}

describe('markers for fixture plugins', () => {
  it('shows an ordinary plugin as not seen on every marker, apart from the program-less run itself', async () => {
    const result = await markersFor('ordinary.mjs')
    for (const key of MARKER_KEYS) expect(result.markers[key].state).toBe('not-seen')
  })

  it('Opens a door: a plugin that listens on the loopback address', async () => {
    const result = await markersFor('fetches-declared-url.mjs')
    expect(result.markers.opensADoor.state).toBe('seen')
    expect(result.markers.opensADoor.summary).toMatch(/^Started listening on 127\.0\.0\.1:\d+, on this machine only, in this test\.$/)
    expect(result.markers.sendsOut.state).toBe('not-seen')
  })

  it('Acts for you: a plugin that starts programs', async () => {
    const result = await markersFor('starts-programs.mjs')
    expect(result.markers.actsForYou.state).toBe('seen')
    expect(result.markers.actsForYou.summary).toMatch(/^Started (node|sh)/)
    expect(result.findings?.[0]).toContain('Acts for you: seen and not declared')
  })

  it('Acts for you: declared, so it is not a finding', async () => {
    const result = await markersFor('starts-programs.mjs', {}, { actsForYou: { does: true, why: 'Runs node to check its own version.' } })
    expect(result.markers.actsForYou.state).toBe('declared')
    expect(result.findings).toBeUndefined()
  })

  it('Sends out: a datagram to another machine; the contents of what went out are not checked', async () => {
    const result = await markersFor('sends-udp.mjs')
    expect(result.markers.sendsOut.state).toBe('seen')
    expect(result.markers.sendsOut.summary).toBe('Connected to 192.0.2.1:9 in this test.')
    expect(result.markers.chats.state).toBe('not-checked')
    expect(result.contentsChecked).toBe(false)
  })

  it('Model keys and Other secrets: environment names a plugin looks up', async () => {
    const result = await markersFor('reads-env.mjs', { env: { READ_NAMES: 'DEEPSEEK_API_KEY,GITHUB_TOKEN,HOME' } })
    expect(result.markers.modelKeys.summary).toBe('Looked up DEEPSEEK_API_KEY in its environment.')
    expect(result.markers.otherSecrets.summary).toBe('Looked up GITHUB_TOKEN in its environment.')
    expect(result.markers.code.state).toBe('not-seen')
  })

  it('Other secrets: a plugin that lists the whole environment', async () => {
    const result = await markersFor('reads-env.mjs', { env: { ENUMERATE: '1' } })
    expect(result.markers.otherSecrets.summary).toBe('Listed all the names in its environment.')
  })

  it('Other secrets and Your code: credential files and the planted workspace file a plugin opens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-fixture-files-'))
    temporary.push(dir)
    const key = join(dir, 'id_ed25519')
    const marker = join(dir, 'bench-marker.txt')
    await writeFile(key, 'fake')
    await writeFile(marker, 'fake')
    const result = await markersFor('reads-files.mjs', {
      args: [key, marker, join(dir, 'missing')],
      watch: [{ label: '~/.ssh/id_ed25519', path: key }, { label: 'workspace marker file', path: marker }],
    })
    expect(result.markers.otherSecrets.summary).toBe('Opened ~/.ssh/id_ed25519 in this test.')
    expect(result.markers.code.summary).toBe('Opened a file in your workspace that the test planted.')
    expect(result.markers.modelKeys.state).toBe('not-seen')
  })
})
