/** Offline source compilation preserves npm inputs and includes the browser's graph-external resources. */
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { buildFrontend } from '../scripts/devtools/vite.ts'
import { frontendSourceRoot } from '../scripts/devtools/inputs.ts'

/** Lists every file below a directory as a slash-separated relative path. */
async function filesBelow(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) files.push(...await filesBelow(root, path))
    else files.push(path)
  }
  return files
}

async function sourceHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(join(root, path), { withFileTypes: true })
    for (const item of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path ? `${path}/${item.name}` : item.name
      hash.update(name)
      if (item.isDirectory()) await visit(name)
      else if (item.isFile()) hash.update(await readFile(join(root, name)))
    }
  }
  await visit('')
  return hash.digest('hex')
}

it('builds from fixed installed sources with network APIs blocked and includes Memory and injected entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devtools-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = await frontendSourceRoot()
  const before = await sourceHash(source)
  const deny = (): never => { throw new Error('DevTools build attempted network access') }
  const guards = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(deny),
    vi.spyOn(http, 'request').mockImplementation(deny),
    vi.spyOn(http, 'get').mockImplementation(deny),
    vi.spyOn(https, 'request').mockImplementation(deny),
    vi.spyOn(https, 'get').mockImplementation(deny),
  ]
  onTestFinished(() => { for (const guard of guards) guard.mockRestore() })
  await buildFrontend(root)
  for (const guard of guards) expect(guard).not.toHaveBeenCalled()
  expect(await sourceHash(source)).toBe(before)
  for (const path of [
    'devtools_app.html', 'connect.js', 'entrypoints/devtools_app/devtools_app.js',
    'entrypoints/heap_snapshot_worker/heap_snapshot_worker-entrypoint.js',
    'entrypoints/formatter_worker/formatter_worker-entrypoint.js',
    'entrypoints/wasmparser_worker/wasmparser_worker-entrypoint.js',
    'entrypoints/lighthouse_worker/lighthouse_worker.js',
    'panels/recorder/injected/injected.generated.js',
    'models/live-metrics/web-vitals-injected/web-vitals-injected.generated.js',
    'Images/chromeLeft.avif', 'Images/lighthouse_logo.svg',
    'LICENSE', 'third_party/codemirror/package/LICENSE', 'third_party/wasmparser/package/LICENSE',
  ]) expect((await readFile(join(root, path))).length, path).toBeGreaterThan(0)
  const html = await readFile(join(root, 'devtools_app.html'), 'utf8')
  expect(html).not.toContain('chrome-devtools-frontend.appspot.com')
  expect(html).not.toContain('importmap')
  expect(html.indexOf('./connect.js')).toBeLessThan(html.indexOf('./entrypoints/devtools_app/devtools_app.js'))
  await expect(readdir(join(root, 'core/i18n/locales'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('publishes no build-machine path: home directory, user name segment or checkout root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devtools-paths-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await buildFrontend(root)
  const checkout = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/u, '')
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const literals = [...new Set([homedir(), checkout, checkout.split(sep).join('/')])]
  const segment = new RegExp(`[/\\\\]${escape(userInfo().username)}[/\\\\]`, 'u')
  const files = await filesBelow(root)
  expect(files.length).toBeGreaterThan(100)
  const leaks: string[] = []
  for (const file of files) {
    const text = (await readFile(join(root, file))).toString('latin1')
    for (const literal of literals) if (text.includes(literal)) leaks.push(`${file}: ${literal}`)
    if (segment.test(text)) leaks.push(`${file}: user name path segment`)
  }
  expect(leaks).toEqual([])
})
