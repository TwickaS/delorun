/**
 * The studio's Create a plugin routes: `create` writes a new plugin only below the Delo home's `plugins` folder and only
 * for the person at their computer; `request` records the install from that folder as a change that waits for review and
 * turns nothing on; `reveal` shows only a folder the studio created.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChangeLog } from '@delo/changes'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL, json, post, routeHome, send, serveRoutes } from './routes-fixture.ts'

const RUNNING = { delo: '0.1.0', dsh: '0.2.2' } as never

/**
 * A routes server that scaffolds for a fake installation.
 * @returns the server, the profile, the installation and the folders `reveal` was asked to show.
 */
async function server() {
  const { root, ctx } = routeHome()
  const install = join(root, 'install')
  mkdirSync(join(install, 'node_modules/@deepseek-ai/cordis'), { recursive: true })
  writeFileSync(join(install, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2"}\n')
  writeFileSync(join(install, 'node_modules/@deepseek-ai/cordis/package.json'), '{"name":"@deepseek-ai/cordis","version":"4.0.0"}\n')
  const revealed: string[] = []
  const routes = await serveRoutes(ctx, { scaffold: () => ({ running: RUNNING, installation: { anchor: join(install, 'package.json') } }), reveal: (folder) => { revealed.push(folder) } })
  return { routes, ctx, root, revealed }
}

describe('Create a plugin', () => {
  it('writes the files below the home\'s plugins folder and nowhere else', async () => {
    const { routes, ctx, root } = await server()
    const reply = await post(routes.port, '/delo/changes/create', { name: '@me/hello-tool', kind: 'tool' })
    expect(reply.status).toBe(200)
    const view = json(reply) as { folder: string, files: string[] }
    expect(view.folder).toBe(join(ctx.home, 'plugins', 'hello-tool'))
    expect(readdirSync(view.folder)).toContain('package.json')
    expect(view.files).toContain('package.json')
    expect(readdirSync(join(ctx.home, 'plugins'))).toEqual(['hello-tool'])
    expect(readdirSync(root).sort()).toEqual(['.delo', 'install'])
  })

  it('refuses a name that would leave the folder, a shipped scope and a folder that is not empty, writing nothing', async () => {
    const { routes, ctx } = await server()
    for (const name of ['../escape', '@me/../escape', '/etc/passwd', 'a/b', '@delo/x', '.hidden']) {
      const reply = await post(routes.port, '/delo/changes/create', { name, kind: 'tool' })
      expect(reply.status, name).toBe(400)
    }
    expect(await post(routes.port, '/delo/changes/create', { name: 'okay', kind: 'nothing' })).toMatchObject({ status: 400 })
    expect(existsSync(join(ctx.home, 'plugins', 'escape'))).toBe(false)
    expect((await post(routes.port, '/delo/changes/create', { name: 'okay', kind: 'preset' })).status).toBe(200)
    expect((await post(routes.port, '/delo/changes/create', { name: 'okay', kind: 'preset' })).status).toBe(409)
  })

  it('answers a remote session, another site and a page without the credential before it reads the body or writes a file', async () => {
    const { routes, ctx } = await server()
    for (const path of ['create', 'request', 'reveal']) {
      const target = `/delo/changes/${path}`
      const body = { name: 'remote-made', kind: 'tool' }
      expect(json(await send(routes.port, target, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body, withholdBody: true }))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
      expect(json(await send(routes.port, target, { method: 'POST', headers: [CREDENTIAL, 'Sec-Fetch-Site: cross-site'], body, withholdBody: true }))).toMatchObject({ code: 'CROSS_SITE' })
      expect((await send(routes.port, target, { method: 'POST', headers: [], body })).status).toBe(401)
    }
    expect(existsSync(join(ctx.home, 'plugins'))).toBe(false)
  })

  it('records the install of a created folder as a change that waits, and turns nothing on', async () => {
    const { routes, ctx } = await server()
    await post(routes.port, '/delo/changes/create', { name: 'waiting', kind: 'tool' })
    const reply = await post(routes.port, '/delo/changes/request', { name: 'waiting' })
    expect(reply.status).toBe(200)
    const entries = (await readChangeLog(ctx.home, ctx.profile)).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ state: 'pending', kind: 'plugin-install' })
    expect(routes.reloads()).toBe(0)
    expect(routes.operations).toEqual([])
  })

  it('records and reveals only a plugin the studio created', async () => {
    const { routes, ctx, revealed } = await server()
    mkdirSync(join(ctx.home, 'plugins', 'stray'), { recursive: true })
    writeFileSync(join(ctx.home, 'plugins', 'stray', 'package.json'), '{"name":"another"}\n')
    for (const name of ['stray', 'missing', '../profiles', '.', '']) {
      expect((await post(routes.port, '/delo/changes/request', { name })).status, name).toBeGreaterThanOrEqual(400)
      expect((await post(routes.port, '/delo/changes/reveal', { name })).status, name).toBeGreaterThanOrEqual(400)
    }
    expect(revealed).toEqual([])
    expect((await readChangeLog(ctx.home, ctx.profile)).entries).toEqual([])
    await post(routes.port, '/delo/changes/create', { name: 'shown', kind: 'bundle' })
    expect(json(await post(routes.port, '/delo/changes/reveal', { name: 'shown' }))).toEqual({ kind: 'revealed', folder: join(ctx.home, 'plugins', 'shown') })
    expect(revealed).toEqual([join(ctx.home, 'plugins', 'shown')])
  })
})
