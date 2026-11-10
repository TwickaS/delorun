/**
 * `delorun plugin check <directory>` (`delo/apps/cli/src/plugin-check.ts`): what a plugin's declared ranges admit
 * against a release, by the installer's own evaluation, read from its `package.json` alone.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SemanticVersion } from '@delo/contract-release-manifest'
import { EXIT } from '../src/exit.ts'
import { PLUGIN_MANIFEST_LIMIT, runPluginCheck, targetRange } from '../src/plugin-check.ts'
import { pluginCommand } from '../src/upstream.ts'

const RUNNING = { delo: brandString<SemanticVersion>('0.1.3'), dsh: brandString<SemanticVersion>('0.2.2') }
let directories: string[] = []

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories = []
})

/**
 * A plugin directory.
 * @param manifest - its `package.json` text, or an object to write as JSON.
 * @param files - other files it holds.
 * @returns its path.
 */
function plugin(manifest: string | object, files: Readonly<Record<string, string>> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'dpc-'))
  directories.push(directory)
  writeFileSync(join(directory, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content)
  return directory
}

/**
 * Run the check and collect what it prints.
 * @param directory - the plugin.
 * @returns the exit code and the output.
 */
async function check(directory: string): Promise<{ readonly exit: number | undefined, readonly out: string }> {
  let out = ''
  const exit = await runPluginCheck([directory], { env: {}, stdout: (text) => { out += text }, stderr: () => {} }, RUNNING)
  return { exit, out }
}

describe('delorun plugin check', () => {
  it('plugin-check-imports-no-code: reads the manifest and runs none of the plugin\'s files', async () => {
    const canary = join(tmpdir(), `dpc-canary-${String(process.pid)}`)
    const code = `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'ran')\nimport('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(canary)}, 'ran'))\n`
    const directory = plugin({ name: 'example', version: '1.0.0', main: 'index.js', exports: './index.js', scripts: { preinstall: 'node index.js', prepare: 'node index.js' }, engines: { delo: '^0.1.0' } }, { 'index.js': code })
    const { exit, out } = await check(directory)
    expect(exit).toBe(EXIT.ok)
    expect(out).toContain('none of its files ran')
    expect(existsSync(canary)).toBe(false)
  })

  it('says what each declared range admits, and that the installer admits the plugin', async () => {
    const { exit, out } = await check(plugin({ name: 'example', version: '1.4.0', engines: { dsh: '>=0.2.2 <0.3.0', delo: '^0.1.0' } }))
    expect(exit).toBe(EXIT.ok)
    expect(out.split('\n')).toEqual([
      expect.stringMatching(/^example@1\.4\.0, read from .*package\.json; none of its files ran\.$/u),
      'This is Delo 0.1.3 on DSH 0.2.2.',
      'DSH axis: engines.dsh ">=0.2.2 <0.3.0" admits DSH 0.2.2; without engines.dsh every DSH peer must admit it, and engines.dsh alone decides when it is declared.',
      'Delo axis: engines.delo admits Delo 0.1.3.',
      'The installer admits it on this release.',
      'Within one Delo minor the DSH version stays the same; contract C21 states what each Delo version promises a plugin.',
      '',
    ])
  })

  it('says when engines.dsh does not admit the running DSH', async () => {
    const { exit, out } = await check(plugin({ name: 'old', version: '1.0.0', engines: { dsh: '^0.1.0' } }))
    expect(exit).toBe(EXIT.failed)
    expect(out).toContain('DSH axis: it requires DSH ^0.1.0, which DSH 0.2.2 does not meet.')
  })

  it('says which DSH peers admit the running DSH when engines.dsh is absent', async () => {
    const { exit, out } = await check(plugin({ name: 'peered', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0', 'react': '^18.0.0' } }))
    expect(exit).toBe(EXIT.ok)
    expect(out).toContain('DSH axis: its DSH peers (@deepseek-ai/dsh-agent "^0.2.0") admits DSH 0.2.2;')
  })

  it('names what is undeclared, and the range that targets the running Delo minor', async () => {
    const { exit, out } = await check(plugin({ name: 'stock-plugin', version: '1.0.0' }))
    expect(exit).toBe(EXIT.ok)
    expect(out).toContain('DSH axis: undeclared, so the plugin loads on any DSH. Declare "engines": { "dsh": "^0.2.2" }')
    expect(out).toContain('Delo axis: undeclared, so the plugin loads on any Delo and Delo promises it nothing. To target Delorun 0.1.3 and its patches, declare "engines": { "delo": "^0.1.0" }.')
  })

  it('refuses a plugin whose Delo range does not admit this release, with the installer\'s own message', async () => {
    const { exit, out } = await check(plugin({ name: 'future', version: '2.0.0', engines: { delo: '>=0.2.0' } }))
    expect(exit).toBe(EXIT.failed)
    expect(out).toContain('Delo axis: engines.delo ">=0.2.0" does not admit Delo 0.1.3.')
    expect(out).toContain('The installer refuses it on this release: future@2.0.0 requires Delo >=0.2.0; this is Delo 0.1.3 on DSH 0.2.2.')
  })

  it('reads the DSH peers when engines.dsh is absent, as upstream does', async () => {
    const { exit, out } = await check(plugin({ name: 'peers', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.3.0', '@deepseek-ai/dsh-tools': 'workspace:*', 'react': '^18.0.0' } }))
    expect(exit).toBe(EXIT.failed)
    expect(out).toContain('DSH axis: it requires DSH ^0.3.0 (peer @deepseek-ai/dsh-agent), which DSH 0.2.2 does not meet.')
    expect(out).not.toContain('react')
    expect(out).toContain('The installer refuses it on this release: Plugin peers@1.0.0 is incompatible with dsh 0.2.2')
  })

  it('refuses declarations it cannot read', async () => {
    expect((await check(plugin({ name: 'a', version: '1.0.0', engines: { delo: 1 } }))).out).toContain('Delo axis: engines.delo is declared in a form Delo cannot read, so Delo refuses the plugin. Declare a range such as "^0.1.0".')
    const dsh = await check(plugin({ name: 'b', version: '1.0.0', engines: { dsh: 1 } }))
    expect([dsh.exit, dsh.out.includes('DSH axis: engines.dsh or a DSH peer is declared in a form Delo cannot read.'), dsh.out.includes('The installer refuses it: ')]).toEqual([EXIT.failed, true, true])
    const peer = await check(plugin({ name: 'c', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': 3 } }))
    expect(peer.out).toContain('DSH axis: engines.dsh or a DSH peer is declared in a form Delo cannot read.')
    const engines = await check(plugin({ name: 'd', version: '1.0.0', engines: 'dsh' }))
    expect([engines.exit, engines.out.includes('Delo axis: engines.delo is declared in a form Delo cannot read')]).toEqual([EXIT.failed, true])
    expect((await check(plugin({ engines: { delo: '^0.1.0' } }))).out).toContain('(no name)@(no version)')
  })

  it('refuses a manifest that is missing, too large, not JSON or not an object', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dpc-'))
    directories.push(empty)
    await expect(check(empty)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('cannot be read') })
    await expect(check(plugin(' '.repeat(PLUGIN_MANIFEST_LIMIT + 1)))).rejects.toMatchObject({ message: expect.stringContaining(`more than ${String(PLUGIN_MANIFEST_LIMIT)} bytes, the limit`) })
    await expect(check(plugin('{'))).rejects.toMatchObject({ message: expect.stringContaining('is not JSON') })
    await expect(check(plugin('[]'))).rejects.toMatchObject({ message: expect.stringContaining('is not a package manifest object') })
    const folder = mkdtempSync(join(tmpdir(), 'dpc-'))
    directories.push(folder)
    mkdirSync(join(folder, 'package.json'))
    await expect(check(folder)).rejects.toMatchObject({ message: expect.stringContaining('it is not a regular file') })
  })

  it.skipIf(process.platform === 'win32')('plugin-check-refuses-special-files: refuses a manifest that is a FIFO or a symbolic link, without waiting or following it', async () => {
    const fifo = mkdtempSync(join(tmpdir(), 'dpc-'))
    directories.push(fifo)
    execFileSync('mkfifo', [join(fifo, 'package.json')])
    await expect(check(fifo)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('it is not a regular file') })
    const target = plugin({ name: 'linked', version: '1.0.0' })
    const linked = mkdtempSync(join(tmpdir(), 'dpc-'))
    directories.push(linked)
    symlinkSync(join(target, 'package.json'), join(linked, 'package.json'))
    await expect(check(linked)).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('cannot be read') })
  })

  it('plugin-check-escapes-manifest-text: prints the manifest\'s name and ranges with terminal control characters escaped', async () => {
    const hostile = '\u001b]0;owned\u0007\u001b[2J'
    const { out } = await check(plugin({ name: `evil${hostile}`, version: '1.0.0', engines: { dsh: `>=0.2.0${hostile}`, delo: `^0.1.0${hostile}` }, peerDependencies: { '@deepseek-ai/dsh-agent': `^0.2.0${hostile}` } }))
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/u)
    expect(out).toContain('evil')
  })

  it('takes exactly one directory, through delorun plugin check', async () => {
    const context = { env: {}, stdout: () => {}, stderr: () => {} }
    await expect(runPluginCheck([], context, RUNNING)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(runPluginCheck(['a', 'b'], context, RUNNING)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(runPluginCheck(['--json'], context, RUNNING)).rejects.toMatchObject({ exit: EXIT.usage })
    const directory = plugin({ name: 'e', version: '1.0.0' })
    mkdirSync(join(directory, 'sub'))
    let out = ''
    expect(await pluginCommand.run(['check', directory], { env: {}, stdout: (text) => { out += text }, stderr: () => {} })).toBe(EXIT.ok)
    expect(out).toContain('e@1.0.0')
  })

  it('targets the running minor, before and after 1.0', () => {
    expect(targetRange('0.1.3')).toBe('^0.1.0')
    expect(targetRange('1.4.2-rc.1')).toBe('^1.4.0')
  })
})
