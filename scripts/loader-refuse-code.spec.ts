/** `refuseCode` refuses embedded code — `!!js` expressions and patch `insert` rows — in parsed configs; off, loading is upstream's. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { RefusedCodeError } from '@deepseek-ai/cordis-plugin-loader'
import { loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

declare global {
  var __refuseCodeCanary: number | undefined
}

/** A `!!js` body that leaves a side-effect marker, so any evaluation is observable. */
const CANARY = 'globalThis.__refuseCodeCanary = (globalThis.__refuseCodeCanary ?? 0) + 1'

/** Reject with the failure a failed fiber recorded, or fail when it resolves. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected the fiber to fail') }, error => error)
}

/** Mount the loader on a fresh context with a temp base URL and a no-op builtin probe plugin. */
async function tempContext(refuseCode: boolean): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-refuse-code-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader, refuseCode ? { refuseCode: true } : {})
  ctx.loader.builtins.probe = { apply() {} }
  return ctx
}

/** Write one patch list into a temp file removed with the test. */
async function tempPatchFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-refuse-code-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'cordis.patch.yml')
  await writeFile(file, content)
  return file
}

it('refuses a !!js expression with the typed error and never evaluates it', async () => {
  const ctx = await tempContext(true)
  const id = await ctx.loader.create({ name: 'cordis:probe', config: { marker: { __jsExpr: CANARY } } })
  const entry = ctx.loader.resolve(id)
  const failure = await refusal(entry.fiber!.await())
  const file = `${ctx.baseUrl}#${entry.options.id}`
  expect(failure).toBeInstanceOf(RefusedCodeError)
  expect((failure as RefusedCodeError).message)
    .toBe(`refuseCode: !!js expression at config.marker in ${file} (embedded code is forbidden)`)
  expect((failure as RefusedCodeError).file).toBe(file)
  expect((failure as RefusedCodeError).path).toEqual(['marker'])
  expect(globalThis.__refuseCodeCanary).toBeUndefined()
})

it('reports the expression path through nested config and arrays', async () => {
  const ctx = await tempContext(true)
  const id = await ctx.loader.create({ name: 'cordis:probe', config: { rows: [{ host: { __jsExpr: CANARY } }] } })
  const entry = ctx.loader.resolve(id)
  const failure = await refusal(entry.fiber!.await())
  const file = `${ctx.baseUrl}#${entry.options.id}`
  expect((failure as RefusedCodeError).message)
    .toBe(`refuseCode: !!js expression at config.rows[0].host in ${file} (embedded code is forbidden)`)
  expect((failure as RefusedCodeError).file).toBe(file)
  expect((failure as RefusedCodeError).path).toEqual(['rows', 0, 'host'])
  expect(globalThis.__refuseCodeCanary).toBeUndefined()
})

it('loads expression-free config unchanged with the option on', async () => {
  const ctx = await tempContext(true)
  const id = await ctx.loader.create({ name: 'cordis:probe', config: { marker: 'literal' } })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  expect(entry.options.config).toEqual({ marker: 'literal' })
})

it('loads a !!js expression exactly as upstream does with the option off', async () => {
  const ctx = await tempContext(false)
  const before = globalThis.__refuseCodeCanary ?? 0
  const id = await ctx.loader.create({ name: 'cordis:probe', config: { marker: { __jsExpr: CANARY } } })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  expect(globalThis.__refuseCodeCanary).toBe(before + 1)
  expect(entry.options.config).toEqual({ marker: { __jsExpr: CANARY } })
  expect(entry.fiber!.effectiveConfig).toEqual({ marker: 1 })
})

it('refuses an overlay insert row with the same typed error naming the file and path', async () => {
  const file = await tempPatchFile('- insert:\n    - id: tool\n      name: cordis:probe\n')
  const refuse = () => loadOverlayPatches('refuse-code', file, true)
  expect(refuse).toThrow(RefusedCodeError)
  try {
    refuse()
    expect.unreachable()
  } catch (error) {
    expect((error as RefusedCodeError).message)
      .toBe(`refuse-code: refuseCode: overlay ${file} holds an insert row at patches[0].insert (inserted rows are forbidden)`)
    expect((error as RefusedCodeError).file).toBe(file)
    expect((error as RefusedCodeError).path).toEqual(['patches', 0, 'insert'])
  }
})

it('refuses an insert row in the optional user patch file and keeps a missing file as no layer', async () => {
  const file = await tempPatchFile('- id: tool\n- insert:\n    - id: extra\n      name: cordis:probe\n')
  expect(() => loadOptionalPatches('refuse-code', file, true)).toThrow(RefusedCodeError)
  try {
    loadOptionalPatches('refuse-code', file, true)
    expect.unreachable()
  } catch (error) {
    expect((error as RefusedCodeError).message)
      .toBe(`refuse-code: refuseCode: patches ${file} holds an insert row at patches[1].insert (inserted rows are forbidden)`)
    expect((error as RefusedCodeError).path).toEqual(['patches', 1, 'insert'])
  }
  const absent = join(dirname(file), 'absent.patch.yml')
  expect(loadOptionalPatches('refuse-code', absent, true)).toBeUndefined()
})

it('parses a list without insert rows unchanged with the option on', async () => {
  const file = await tempPatchFile('- id: tool\n  disabled: true\n')
  expect(loadOverlayPatches('refuse-code', file, true)).toEqual([{ id: 'tool', disabled: true }])
})

it('parses patch lists exactly as upstream does with the option off', async () => {
  const file = await tempPatchFile('- insert:\n    - id: tool\n      name: cordis:probe\n')
  expect(loadOverlayPatches('refuse-code', file)).toEqual([{ insert: [{ id: 'tool', name: 'cordis:probe' }] }])
})
