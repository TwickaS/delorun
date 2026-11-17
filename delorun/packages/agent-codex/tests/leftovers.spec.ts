import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountPoints, parseMountPoints, recordAbsentNames, removeSandboxLeftovers } from '../src/leftovers.ts'

const HAS_BWRAP = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ea1-codex-leftovers-'))
  roots.push(root)
  return root
}

describe('sandbox leftovers (decision 5)', () => {
  it('records only the protected names a root lacks', () => {
    const root = scratch()
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.codex'), '')
    expect(recordAbsentNames([root, root])).toEqual([{ root, absent: ['.agents'] }])
  })

  it('removes a name that was absent and is now an empty folder', () => {
    const root = scratch()
    const records = recordAbsentNames([root])
    for (const name of ['.git', '.agents', '.codex']) mkdirSync(join(root, name))
    expect(removeSandboxLeftovers(records)).toEqual(['.git', '.agents', '.codex'].map(name => join(root, name)))
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('keeps a folder that existed before, even when it is empty', () => {
    const root = scratch()
    mkdirSync(join(root, '.git'))
    const records = recordAbsentNames([root])
    expect(removeSandboxLeftovers(records)).toEqual([])
    expect(existsSync(join(root, '.git'))).toBe(true)
  })

  it('keeps a new folder with anything in it, a new file and a new link, and removes nothing inside them', () => {
    const root = scratch()
    const target = scratch()
    const records = recordAbsentNames([root])
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.agents'), 'notes')
    symlinkSync(target, join(root, '.codex'))
    expect(removeSandboxLeftovers(records)).toEqual([])
    expect(['.git/HEAD', '.agents', '.codex'].map(name => existsSync(join(root, name)))).toEqual([true, true, true])
    expect(existsSync(target)).toBe(true)
  })

  it('never removes anything outside the three names', () => {
    const root = scratch()
    const records = recordAbsentNames([root])
    mkdirSync(join(root, 'empty'))
    removeSandboxLeftovers(records)
    expect(existsSync(join(root, 'empty'))).toBe(true)
  })

  it('keeps a leftover that another running sandbox has mounted over, and removes it once that sandbox ends', { skip: !HAS_BWRAP, timeout: 30_000 }, async () => {
    const root = scratch()
    const records = recordAbsentNames([root])
    const source = join(root, 'source')
    mkdirSync(source)
    mkdirSync(join(root, '.git'))
    // A sandbox in its own mount namespace, as Codex's is, with a read-only mount over the shared root's .git.
    const other = spawn('bwrap', ['--die-with-parent', '--dev-bind', '/', '/', '--ro-bind', source, join(root, '.git'), 'sleep', '30'], { stdio: 'ignore' })
    const ended = new Promise<void>((resolve) => { other.once('exit', () => { resolve() }) })
    const mounted = () => mountPoints().has(join(root, '.git'))
    try {
      await until(mounted)
      expect(removeSandboxLeftovers(records)).toEqual([])
      expect(existsSync(join(root, '.git'))).toBe(true)
    } finally {
      other.kill('SIGKILL')
      await ended
    }
    await until(() => !mounted())
    expect(removeSandboxLeftovers(records)).toEqual([join(root, '.git')])
  })
})

/** Wait until a condition holds, for at most five seconds. */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 100) throw new Error('the condition never held')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('mount points', () => {
  it('reads the mount point field and decodes its octal escapes', () => {
    const text = [
      '36 35 98:0 /mnt1 /mnt/with\\040space rw,noatime master:1 - ext3 /dev/root rw',
      '37 35 0:5 / /tmp/run/.git ro,relatime - tmpfs tmpfs rw',
      '',
    ].join('\n')
    expect(parseMountPoints(text)).toEqual(['/mnt/with space', '/tmp/run/.git'])
  })

  it('finds none without a proc file system', () => {
    expect(mountPoints(join(scratch(), 'no-proc'))).toEqual(new Set())
  })
})
