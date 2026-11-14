/**
 * The studio's Create a plugin routes: `create` writes a new plugin only below a known workspace's `plugins` folder and
 * only for the person at their computer; `request` records the install from that folder as a change that waits for
 * review and turns nothing on; `reveal` shows only a folder the studio created.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_KINDS } from '@delorun/plugin-scaffold'
import { readChangeLog } from '@delorun/changes'
import { describe, expect, it } from 'vitest'
import { CREATE_KINDS } from '../src/wire.ts'
import { CREDENTIAL, json, post, routeHome, send, serveRoutes } from './routes-fixture.ts'

const RUNNING = { delorun: '0.1.0', dsh: '0.2.2' } as never

/**
 * A routes server that scaffolds for a fake installation, with two workspaces.
 * @returns the server, the profile, the workspaces' folders and the folders `reveal` was asked to show.
 */
async function server() {
  const { root, ctx } = routeHome()
  const install = join(root, 'install')
  mkdirSync(join(install, 'node_modules/@deepseek-ai/cordis'), { recursive: true })
  writeFileSync(join(install, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2"}\n')
  writeFileSync(join(install, 'node_modules/@deepseek-ai/cordis/package.json'), '{"name":"@deepseek-ai/cordis","version":"4.0.0"}\n')
  mkdirSync(join(root, 'work', 'first'), { recursive: true })
  mkdirSync(join(root, 'work', 'second'), { recursive: true })
  const first = realpathSync(join(root, 'work', 'first'))
  const second = realpathSync(join(root, 'work', 'second'))
  const revealed: string[] = []
  const routes = await serveRoutes(ctx, {
    scaffold: () => ({ running: RUNNING, installation: { anchor: join(install, 'package.json') } }),
    workspaces: () => [{ id: 'w1', title: 'First', path: first }, { id: 'w2', title: 'Second', path: second }],
    reveal: (folder) => { revealed.push(folder) },
  })
  return { routes, ctx, root, first, second, revealed }
}

describe('Create a plugin', () => {
  it('offers the scaffold\'s kinds', () => {
    expect([...CREATE_KINDS]).toEqual([...PLUGIN_KINDS])
  })

  it('lists the workspaces, the default first', async () => {
    const { routes, first, second } = await server()
    const reply = await send(routes.port, '/delorun/changes/workspaces', { method: 'GET', headers: [CREDENTIAL] })
    expect(json(reply)).toEqual({ atComputer: true, workspaces: [{ id: 'w1', title: 'First', path: first }, { id: 'w2', title: 'Second', path: second }] })
  })

  it('writes the files into the default workspace\'s plugins folder, or the one named, and nowhere else', async () => {
    const { routes, ctx, first, second } = await server()
    const reply = await post(routes.port, '/delorun/changes/create', { name: '@me/hello-tool', kind: 'tool' })
    expect(reply.status).toBe(200)
    const view = json(reply) as { folder: string, files: string[], workspace: string }
    expect(view).toMatchObject({ folder: join(first, 'plugins', 'hello-tool'), workspace: 'w1' })
    expect(readdirSync(view.folder)).toContain('package.json')
    expect(view.files).toContain('package.json')
    expect(json(await post(routes.port, '/delorun/changes/create', { name: 'other', kind: 'preset', workspace: 'w2' }))).toMatchObject({ folder: join(second, 'plugins', 'other') })
    expect(readdirSync(first)).toEqual(['plugins'])
    expect(existsSync(join(ctx.home, 'plugins'))).toBe(false)
  })

  it('refuses a workspace the registry does not hold, and a Host with no workspace, writing nothing', async () => {
    const { routes, root } = await server()
    for (const workspace of ['w9', '../', '/etc', 7]) {
      expect((await post(routes.port, '/delorun/changes/create', { name: 'okay', kind: 'tool', workspace })).status, String(workspace)).toBe(404)
    }
    expect(existsSync(join(root, 'plugins'))).toBe(false)
    const { ctx } = routeHome()
    const bare = await serveRoutes(ctx, { scaffold: () => ({ running: RUNNING, installation: { anchor: join(root, 'install', 'package.json') } }) })
    expect(json(await post(bare.port, '/delorun/changes/create', { name: 'okay', kind: 'tool' }))).toMatchObject({ code: 'NO_WORKSPACE' })
  })

  it('refuses a name that would leave the folder, a shipped scope and a folder that is not empty, writing nothing', async () => {
    const { routes, first, root } = await server()
    for (const name of ['../escape', '@me/../escape', '/etc/passwd', 'a/b', '@delorun/x', '.hidden']) {
      const reply = await post(routes.port, '/delorun/changes/create', { name, kind: 'tool' })
      expect(reply.status, name).toBe(400)
    }
    expect(await post(routes.port, '/delorun/changes/create', { name: 'okay', kind: 'nothing' })).toMatchObject({ status: 400 })
    expect(existsSync(join(first, 'plugins'))).toBe(false)
    expect(existsSync(join(root, 'work', 'escape'))).toBe(false)
    expect((await post(routes.port, '/delorun/changes/create', { name: 'okay', kind: 'preset' })).status).toBe(200)
    expect((await post(routes.port, '/delorun/changes/create', { name: 'okay', kind: 'preset' })).status).toBe(409)
  })

  it('refuses a plugins folder or a plugin folder that is a link, writing through neither', async () => {
    const { routes, first, second, root } = await server()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(first, 'plugins'))
    expect((await post(routes.port, '/delorun/changes/create', { name: 'linked-dir', kind: 'tool', workspace: 'w1' })).status).toBe(409)
    expect(readdirSync(elsewhere)).toEqual([])
    mkdirSync(join(second, 'plugins'))
    symlinkSync(elsewhere, join(second, 'plugins', 'linked-plugin'))
    expect((await post(routes.port, '/delorun/changes/create', { name: 'linked-plugin', kind: 'tool', workspace: 'w2' })).status).toBe(409)
    expect(readdirSync(elsewhere)).toEqual([])
    writeFileSync(join(elsewhere, 'package.json'), '{"name":"linked-plugin"}\n')
    expect((await post(routes.port, '/delorun/changes/request', { name: 'linked-plugin', workspace: 'w2' })).status).toBe(404)
    expect((await post(routes.port, '/delorun/changes/reveal', { name: 'linked-plugin', workspace: 'w2' })).status).toBe(404)
    expect((await post(routes.port, '/delorun/changes/request', { name: 'linked-dir', workspace: 'w1' })).status).toBe(404)
  })

  it('answers a remote session, another site and a page without the credential before it reads the body or writes a file', async () => {
    const { routes, ctx, first } = await server()
    for (const path of ['create', 'request', 'reveal']) {
      const target = `/delorun/changes/${path}`
      const body = { name: 'remote-made', kind: 'tool', workspace: 'w1' }
      expect(json(await send(routes.port, target, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body, withholdBody: true }))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
      expect(json(await send(routes.port, target, { method: 'POST', headers: [CREDENTIAL, 'Sec-Fetch-Site: cross-site'], body, withholdBody: true }))).toMatchObject({ code: 'CROSS_SITE' })
      expect((await send(routes.port, target, { method: 'POST', headers: [], body })).status).toBe(401)
    }
    expect(existsSync(join(first, 'plugins'))).toBe(false)
    expect(existsSync(join(ctx.home, 'plugins'))).toBe(false)
  })

  it('tells a remote session it is not at the computer', async () => {
    const { routes } = await server()
    expect(json(await send(routes.port, '/delorun/changes/workspaces', { method: 'GET', headers: [CREDENTIAL, 'x-test-remote: 1'] }))).toEqual({ atComputer: false, workspaces: [] })
  })

  it('records the install of a created folder as a change that waits, and turns nothing on', async () => {
    const { routes, ctx, first } = await server()
    await post(routes.port, '/delorun/changes/create', { name: 'waiting', kind: 'tool' })
    const reply = await post(routes.port, '/delorun/changes/request', { name: 'waiting', workspace: 'w1' })
    expect(reply.status).toBe(200)
    const entries = (await readChangeLog(ctx.home, ctx.profile)).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ state: 'pending', kind: 'plugin-install', summary: expect.stringContaining(join(first, 'plugins', 'waiting')) })
    expect(routes.reloads()).toBe(0)
    expect(routes.operations).toEqual([])
  })

  it('records and reveals only a plugin the studio created', async () => {
    const { routes, ctx, first, second, revealed } = await server()
    mkdirSync(join(first, 'plugins', 'stray'), { recursive: true })
    writeFileSync(join(first, 'plugins', 'stray', 'package.json'), '{"name":"another"}\n')
    for (const name of ['stray', 'missing', '../profiles', '.', '']) {
      expect((await post(routes.port, '/delorun/changes/request', { name, workspace: 'w1' })).status, name).toBeGreaterThanOrEqual(400)
      expect((await post(routes.port, '/delorun/changes/reveal', { name, workspace: 'w1' })).status, name).toBeGreaterThanOrEqual(400)
    }
    expect((await post(routes.port, '/delorun/changes/request', { name: 'stray' })).status).toBe(400)
    expect(revealed).toEqual([])
    expect((await readChangeLog(ctx.home, ctx.profile)).entries).toEqual([])
    await post(routes.port, '/delorun/changes/create', { name: 'shown', kind: 'bundle', workspace: 'w2' })
    expect((await post(routes.port, '/delorun/changes/reveal', { name: 'shown', workspace: 'w1' })).status).toBe(404)
    const folder = join(second, 'plugins', 'shown')
    expect(json(await post(routes.port, '/delorun/changes/reveal', { name: 'shown', workspace: 'w2' }))).toEqual({ kind: 'revealed', folder: realpathSync(folder) })
    expect(revealed).toEqual([realpathSync(folder)])
  })
})
