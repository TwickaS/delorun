import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

/**
 * A folder outside every writable root, such as the Browser output folder in the per-user cache folder, cannot be
 * written, removed, renamed or replaced by a link from a confined command, and stays readable. Skips when bwrap or
 * user namespaces are unavailable. The folder is made under the home, as the cache folder is, because bwrap mounts
 * `/tmp` empty for `workspace-write`.
 */
const bwrapUsable = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

let ctx: Context | undefined
const scratch: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe.skipIf(!bwrapUsable)('sandbox-local: a folder outside every writable root under real bwrap', () => {
  it('a confined command can read the output folder but cannot write, remove, rename or replace it', async () => {
    const base = await mkdtemp(join(homedir(), '.dsh-output-folder-e2e-'))
    scratch.push(base)
    const workspace = join(base, 'workspace'), output = join(base, 'cache', 'session'), elsewhere = join(base, 'elsewhere')
    await Promise.all([mkdir(workspace), mkdir(output, { recursive: true }), mkdir(elsewhere)])
    writeFileSync(join(output, 'page.png'), 'png')
    ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { readUnixSockets: () => '' }
    const run = async (command: string, policy: SandboxPolicy): Promise<number | null> => {
      const confined = await sandbox.confine(['bash', '-c', command], policy)
      return spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' }).status
    }
    const policies: SandboxPolicy[] = [
      { mode: 'workspace-write', workspaceRoot: workspace },
      { mode: 'read-only', workspaceRoot: workspace },
    ]
    for (const policy of policies) {
      expect(await run(`cat ${output}/page.png`, policy)).toBe(0)
      for (const command of [
        `echo x > ${output}/planted.png`,
        `rm ${output}/page.png`,
        `rm -rf ${output}`,
        `mv ${output} ${output}.moved`,
        `ln -s ${elsewhere} ${output}/link`,
        `rm -rf ${output} && ln -s ${elsewhere} ${output}`,
        `mv ${output} ${workspace}/taken`,
      ]) expect(await run(command, policy), command).not.toBe(0)
    }
    expect(lstatSync(output).isDirectory()).toBe(true)
    expect(readFileSync(join(output, 'page.png'), 'utf8')).toBe('png')
    expect(existsSync(join(output, 'planted.png'))).toBe(false)
    expect(existsSync(join(output, 'link'))).toBe(false)
    expect(existsSync(`${output}.moved`)).toBe(false)
    // The workspace stays writable, so the denials above come from the folder's place and not from a blanket refusal.
    expect(await run(`echo x > ${workspace}/ok`, policies[0]!)).toBe(0)
  })
})
