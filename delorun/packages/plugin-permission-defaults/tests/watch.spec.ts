/**
 * Specs of the permission store's watch: a burst of changes to the store's file is reported once, a change to another
 * file in its directory is not, a platform that names no file is read as a change, a watch that fails is closed and
 * reported once, and closing drops a pending change.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, type PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The fake watcher the mocked `fs.watch` returns, with the listener it was given. */
const fake = vi.hoisted(() => ({ listener: undefined as ((event: string, name: string | null) => void) | undefined, watcher: undefined as (EventEmitter & { closed: boolean }) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const watch = (_path: PathLike, _options: unknown, listener: (event: string, name: string | null) => void) => {
    fake.listener = listener
    const watcher = Object.assign(new EventEmitter(), { closed: false, close() { watcher.closed = true } })
    fake.watcher = watcher
    return watcher
  }
  return { ...actual, default: { ...actual, watch }, watch }
})
import { PERMISSION_STORE_WATCH_DEBOUNCE_MS, watchPermissionStore } from '../src/watch.ts'

let root: string
let path: string

beforeEach(() => {
  vi.useFakeTimers()
  root = mkdtempSync(join(tmpdir(), 'delorun-permission-watch-'))
  path = join(root, 'secrets', 'permission-defaults', 'workspaces.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Watch the store with counting calls.
 * @returns the counts and the close function.
 */
function watched() {
  const seen = { changed: 0, failed: [] as unknown[] }
  const close = watchPermissionStore(path, { changed: () => { seen.changed++ }, failed: (error) => { seen.failed.push(error) } })
  return { seen, close }
}

describe('the permission store\'s watch', () => {
  it('creates the store\'s directory privately, and reports a burst of changes to the store\'s file once', () => {
    const { seen } = watched()
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    fake.listener?.('rename', '.workspaces.json.tmp-0011223344556677')
    fake.listener?.('rename', 'workspaces.json.lock')
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(0)
    fake.listener?.('rename', 'workspaces.json')
    fake.listener?.('change', 'workspaces.json')
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(1)
  })

  it('reports a change to the dangerous-mode grant file, and to no other file beside the store', () => {
    const { seen } = watched()
    fake.listener?.('rename', 'full-access-everywhere.json')
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(1)
    fake.listener?.('rename', 'full-access-everywhere.json.lock')
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(1)
  })

  it('reads a change that names no file as the store\'s', () => {
    const { seen } = watched()
    fake.listener?.('rename', null)
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(1)
  })

  it('closes and reports a watch that fails, and reports nothing after it', () => {
    const { seen } = watched()
    fake.listener?.('rename', 'workspaces.json')
    fake.watcher?.emit('error', new Error('EPERM'))
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen).toEqual({ changed: 0, failed: [new Error('EPERM')] })
    expect(fake.watcher?.closed).toBe(true)
  })

  it('drops a pending change when closed', () => {
    const { seen, close } = watched()
    fake.listener?.('rename', 'workspaces.json')
    close()
    vi.advanceTimersByTime(PERMISSION_STORE_WATCH_DEBOUNCE_MS)
    expect(seen.changed).toBe(0)
    expect(fake.watcher?.closed).toBe(true)
  })
})
