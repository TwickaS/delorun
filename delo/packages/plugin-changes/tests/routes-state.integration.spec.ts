/**
 * The studio's `state` route, which any admitted session reads and the studio reads every 15 seconds, reads the
 * records only: it writes nothing under the home and reads no plugin's folder, while `show?pending` reads the folder
 * and stores its content. Every call into `node:fs/promises` is recorded with its path, the routes' and Changes' own
 * included.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SHOW_PATH, STATE_PATH } from '../src/routes.ts'
import { approvedPlugin, get, json, serveRoutes } from './routes-fixture.ts'

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const watched = Object.fromEntries((['access', 'copyFile', 'cp', 'link', 'lstat', 'mkdir', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'unlink', 'writeFile'] as const).map(name => [
    name,
    (...args: readonly unknown[]) => {
      touched.push(String(args[0]))
      return (actual[name] as (...forwarded: readonly unknown[]) => unknown)(...args)
    },
  ]))
  return { ...actual, ...watched, default: { ...actual, ...watched } }
})

// Each case writes a temporary home and approves a plugin; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/**
 * Every entry under a directory with its kind, size and modification time.
 * @param root - the directory.
 * @returns one line per entry, by path.
 */
function snapshot(root: string): string[] {
  const lines: string[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stats = lstatSync(path)
      lines.push(`${path} ${stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : 'f'} ${String(stats.size)} ${String(stats.mtimeMs)}`)
      if (stats.isDirectory()) walk(path)
    }
  }
  walk(root)
  return lines
}

describe('the state route', () => {
  it('GET state writes nothing under the home', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const before = snapshot(ctx.home)
    // Pins `recordedChanges` in `stateOf`: computing the pending changes stores the folder's content and the scan cache.
    const state = json(await get(server.port, STATE_PATH))
    expect(state).toMatchObject({ folders: [{ plugin: 'plug', source, kind: 'plugin-edit' }], problems: [] })
    expect(snapshot(ctx.home)).toEqual(before)
    // `show?pending` is the read that stores the folder's content.
    expect(json(await get(server.port, `${SHOW_PATH}?pending`)).pending).toMatchObject([{ plugin: 'plug', kind: 'plugin-edit', files: 1 }])
    expect(snapshot(ctx.home)).not.toEqual(before)
  })

  it('GET state reads no plugin\'s folder', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    touched.length = 0
    // Pins `recordedChanges` in `stateOf`: computing the pending changes scans and hashes every file of the folder.
    expect((await get(server.port, STATE_PATH)).status).toBe(200)
    expect(touched.filter(path => path.startsWith(source))).toEqual([])
    expect(touched.length).toBeGreaterThan(0)
    await get(server.port, `${SHOW_PATH}?pending`)
    expect(touched.filter(path => path.startsWith(source)).length).toBeGreaterThan(0)
  })
})
