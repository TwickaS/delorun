/**
 * Create a plugin when the workspace's `plugins` folder is swapped for a link between the check and the write: the
 * files that landed outside the workspace are removed and the create is refused.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAction, CreateRefusal } from '../src/create-actions.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Create a plugin racing a swap of the plugins folder', () => {
  it('removes what landed outside the workspace and refuses', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-create-swap-')))
    roots.push(root)
    const install = join(root, 'install')
    mkdirSync(join(install, 'node_modules/@deepseek-ai/cordis'), { recursive: true })
    writeFileSync(join(install, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2"}\n')
    writeFileSync(join(install, 'node_modules/@deepseek-ai/cordis/package.json'), '{"name":"@deepseek-ai/cordis","version":"4.0.0"}\n')
    const workspace = join(root, 'work')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    const target = { running: { delorun: '0.1.0', dsh: '0.2.2' } as never, installation: { anchor: join(install, 'package.json') } }
    const swap = async (): Promise<void> => {
      rmSync(join(workspace, 'plugins'), { recursive: true })
      symlinkSync(outside, join(workspace, 'plugins'))
    }
    const refused = await createAction([{ id: 'w', title: 'W', path: workspace }], { name: 'hello', kind: 'tool' }, target, swap).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CreateRefusal)
    expect((refused as CreateRefusal).status).toBe(409)
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(outside, 'hello'))).toBe(false)
  })
})
