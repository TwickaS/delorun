import { execFileSync } from 'node:child_process'
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INSTRUCTIONS, InstructionsRefusedError, readInstructions, repositoryOf, revisionOf, writeInstructions } from '../src/files.ts'

// Records the open calls, so a spec can read the flags and mode a temporary file is created with. Calls pass through.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const LIMIT = 64
const NONE = { text: null, revision: null }

let root: string
let dir: string

/**
 * Expect a promise to refuse with an instructions refusal of one code.
 * @param promise - the call under test.
 * @param code - the refusal code expected.
 * @returns when the call refuses with that code.
 */
async function expectRefusal<T>(promise: Promise<T>, code: 'conflict' | 'too-large'): Promise<void> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(InstructionsRefusedError)
  expect(error).toHaveProperty('code', code)
}

/**
 * The text of a file in the workspace, read without the module under test.
 * @param name - the file's name.
 * @returns the file's text.
 */
function onDisk(name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

/**
 * Create a `.git` directory in the workspace.
 * @param head - the text of `HEAD`.
 * @param config - the text of `config`.
 */
function gitDirectory(head: string, config: string): void {
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), head)
  writeFileSync(join(dir, '.git', 'config'), config)
}

/**
 * A Git config with one origin remote.
 * @param url - the origin's URL.
 * @returns the config text.
 */
function remoteConfig(url: string): string {
  return `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
}

describe.skipIf(process.platform !== 'linux')('instructions files', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delo-files-'))
    dir = join(root, 'workspace')
    mkdirSync(dir)
    vi.mocked(open).mockClear()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('readInstructions', () => {
    it('reads a regular file as text, with the SHA-256 of its bytes as the revision', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), 'Use pnpm.')
      expect(await readInstructions(dir, LIMIT)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
    })

    it('reads a missing file and a missing workspace directory as no file', async () => {
      expect(await readInstructions(dir, LIMIT)).toEqual(NONE)
      expect(await readInstructions(join(root, 'missing'), LIMIT)).toEqual(NONE)
    })

    it('reads a symbolic link named AGENTS.md as no file, never the file it points to', async () => {
      const outside = join(root, 'outside.md')
      writeFileSync(outside, 'secret')
      symlinkSync(outside, join(dir, INSTRUCTIONS))
      expect(await readInstructions(dir, LIMIT)).toEqual(NONE)
    })

    it('reads nothing through a symbolic link at the workspace directory', async () => {
      const real = join(root, 'real')
      mkdirSync(real)
      writeFileSync(join(real, INSTRUCTIONS), 'secret')
      const linked = join(root, 'linked')
      symlinkSync(real, linked)
      expect(await readInstructions(linked, LIMIT)).toEqual(NONE)
    })

    it('reads a directory named AGENTS.md as no file', async () => {
      mkdirSync(join(dir, INSTRUCTIONS))
      expect(await readInstructions(dir, LIMIT)).toEqual(NONE)
    })

    it('reads a FIFO named AGENTS.md as no file without waiting for a writer', async () => {
      execFileSync('mkfifo', [join(dir, INSTRUCTIONS)])
      expect(await readInstructions(dir, LIMIT)).toEqual(NONE)
    })

    it('refuses a file longer than the limit in UTF-8 bytes, though it has fewer characters', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(5))
      await expectRefusal(readInstructions(dir, 12), 'too-large')
    })

    it('reads a file whose UTF-8 bytes equal the limit', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(4))
      expect(await readInstructions(dir, 12)).toEqual({ text: '€'.repeat(4), revision: revisionOf(Buffer.from('€'.repeat(4))) })
    })
  })

  describe('writeInstructions', () => {
    it('writes a new file with mode 0644, reads it back, and leaves no temporary file', async () => {
      await writeInstructions(dir, 'Use pnpm.', null, LIMIT)
      expect(await readInstructions(dir, LIMIT)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
      expect(statSync(join(dir, INSTRUCTIONS)).mode & 0o777).toBe(0o644)
      expect(readdirSync(dir)).toEqual([INSTRUCTIONS])
    })

    it('creates the temporary file with mode 0600 and exclusive creation', async () => {
      await writeInstructions(dir, 'Use pnpm.', null, LIMIT)
      const temporary = vi.mocked(open).mock.calls.filter(([path]) => String(path).includes(`/.${INSTRUCTIONS}.delo-`))
      expect(temporary).toHaveLength(1)
      const [, flags, mode] = temporary[0] ?? []
      expect(mode).toBe(0o600)
      expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL)
    })

    it('replaces the file when the expected revision matches', async () => {
      await writeInstructions(dir, 'one', null, LIMIT)
      const { revision } = await readInstructions(dir, LIMIT)
      await writeInstructions(dir, 'two', revision, LIMIT)
      expect(await readInstructions(dir, LIMIT)).toEqual({ text: 'two', revision: revisionOf(Buffer.from('two')) })
    })

    it('refuses a stale revision, and a null revision when the file exists, and leaves the file as it was', async () => {
      await writeInstructions(dir, 'one', null, LIMIT)
      await expectRefusal(writeInstructions(dir, 'two', revisionOf(Buffer.from('zero')), LIMIT), 'conflict')
      await expectRefusal(writeInstructions(dir, 'two', null, LIMIT), 'conflict')
      expect(onDisk(INSTRUCTIONS)).toBe('one')
    })

    it('removes the file for empty text when the revision matches', async () => {
      await writeInstructions(dir, 'Use pnpm.', null, LIMIT)
      const { revision } = await readInstructions(dir, LIMIT)
      await writeInstructions(dir, '', revision, LIMIT)
      expect(existsSync(join(dir, INSTRUCTIONS))).toBe(false)
      expect(await readInstructions(dir, LIMIT)).toEqual(NONE)
    })

    it('succeeds without a change for empty text when no file exists and the revision is null', async () => {
      await expect(writeInstructions(dir, '', null, LIMIT)).resolves.toBeUndefined()
      expect(readdirSync(dir)).toEqual([])
    })

    it('refuses empty text with a stale revision and keeps the file', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), 'Use pnpm.')
      await expectRefusal(writeInstructions(dir, '', null, LIMIT), 'conflict')
      await expectRefusal(writeInstructions(dir, '', revisionOf(Buffer.from('other')), LIMIT), 'conflict')
      expect(onDisk(INSTRUCTIONS)).toBe('Use pnpm.')
    })

    it('refuses a write through a symbolic link named AGENTS.md and leaves the file it points to unchanged', async () => {
      const outside = join(root, 'outside.md')
      writeFileSync(outside, 'secret')
      symlinkSync(outside, join(dir, INSTRUCTIONS))
      await expectRefusal(writeInstructions(dir, 'planted', null, LIMIT), 'conflict')
      await expectRefusal(writeInstructions(dir, '', null, LIMIT), 'conflict')
      expect(readFileSync(outside, 'utf8')).toBe('secret')
      expect(lstatSync(join(dir, INSTRUCTIONS)).isSymbolicLink()).toBe(true)
    })

    it('refuses a write into a workspace directory that is a symbolic link and leaves the real directory unchanged', async () => {
      const real = join(root, 'real')
      mkdirSync(real)
      writeFileSync(join(real, INSTRUCTIONS), 'secret')
      const linked = join(root, 'linked')
      symlinkSync(real, linked)
      await expectRefusal(writeInstructions(linked, 'planted', null, LIMIT), 'conflict')
      expect(readFileSync(join(real, INSTRUCTIONS), 'utf8')).toBe('secret')
    })

    it('refuses to replace a directory named AGENTS.md and to wait on a FIFO of that name', async () => {
      mkdirSync(join(dir, INSTRUCTIONS))
      await expectRefusal(writeInstructions(dir, 'x', null, LIMIT), 'conflict')
      expect(statSync(join(dir, INSTRUCTIONS)).isDirectory()).toBe(true)
      rmSync(join(dir, INSTRUCTIONS), { recursive: true })
      execFileSync('mkfifo', [join(dir, INSTRUCTIONS)])
      await expectRefusal(writeInstructions(dir, 'x', null, LIMIT), 'conflict')
    })

    it('lets one of two concurrent writes that both expect no file succeed, and refuses the other as a conflict', async () => {
      const results = await Promise.allSettled([writeInstructions(dir, 'first', null, LIMIT), writeInstructions(dir, 'second', null, LIMIT)])
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(InstructionsRefusedError)
      expect(rejected[0]?.reason).toHaveProperty('code', 'conflict')
    })

    it('queues writes through two paths to one directory together', async () => {
      symlinkSync(root, join(root, 'alias'))
      const results = await Promise.allSettled([
        writeInstructions(join(root, 'workspace'), 'first', null, LIMIT),
        writeInstructions(join(root, 'alias', 'workspace'), 'second', null, LIMIT),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    })

    it('refuses text longer than the limit in UTF-8 bytes, though it has fewer characters', async () => {
      await expectRefusal(writeInstructions(dir, 'a'.repeat(LIMIT + 1), null, LIMIT), 'too-large')
      await expectRefusal(writeInstructions(dir, '€'.repeat(5), null, 12), 'too-large')
      expect(readdirSync(dir)).toEqual([])
    })

    it('accepts multi-byte text whose UTF-8 bytes equal the limit', async () => {
      await writeInstructions(dir, '€'.repeat(4), null, 12)
      expect(await readInstructions(dir, 12)).toEqual({ text: '€'.repeat(4), revision: revisionOf(Buffer.from('€'.repeat(4))) })
    })

    it('refuses a write over an existing file longer than the limit, since that file was never read', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(5))
      await expectRefusal(writeInstructions(dir, 'x', null, 12), 'conflict')
    })

    it('refuses to create the file in a missing workspace directory and treats empty text there as a no-op', async () => {
      const missing = join(root, 'missing')
      await expect(writeInstructions(missing, 'x', null, LIMIT)).rejects.toThrow('does not exist')
      await expect(writeInstructions(missing, '', null, LIMIT)).resolves.toBeUndefined()
      await expectRefusal(writeInstructions(missing, '', 'stale', LIMIT), 'conflict')
    })
  })

  describe('repositoryOf', () => {
    it('reads the origin URL and the checked-out branch', async () => {
      gitDirectory('ref: refs/heads/main\n', remoteConfig('https://github.com/acme/widgets.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: 'main' })
    })

    it('shows no origin for a URL with a user name or password', async () => {
      gitDirectory('ref: refs/heads/main\n', remoteConfig('https://user:password@github.com/acme/widgets.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: null, branch: 'main' })
      writeFileSync(join(dir, '.git', 'config'), remoteConfig('https://token@github.com/acme/widgets.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: null, branch: 'main' })
    })

    it('drops the query and fragment from an origin URL', async () => {
      gitDirectory('ref: refs/heads/main\n', remoteConfig('https://github.com/acme/widgets.git?access=abc#top'))
      expect(await repositoryOf(dir)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: 'main' })
    })

    it('keeps an address that is not a URL as written', async () => {
      gitDirectory('ref: refs/heads/main\n', remoteConfig('git@github.com:acme/widgets.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: 'git@github.com:acme/widgets.git', branch: 'main' })
    })

    it('shows no branch for a detached HEAD', async () => {
      gitDirectory('0123456789abcdef0123456789abcdef01234567\n', remoteConfig('https://github.com/acme/widgets.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: null })
    })

    it('shows no repository without a .git directory', async () => {
      expect(await repositoryOf(dir)).toEqual({ origin: null, branch: null })
    })

    it('shows no repository for a .git file, such as a linked worktree', async () => {
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
      expect(await repositoryOf(dir)).toEqual({ origin: null, branch: null })
    })

    it('shows no repository for a .git symbolic link', async () => {
      const real = join(root, 'real.git')
      mkdirSync(real)
      writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(real, 'config'), remoteConfig('https://github.com/acme/widgets.git'))
      symlinkSync(real, join(dir, '.git'))
      expect(await repositoryOf(dir)).toEqual({ origin: null, branch: null })
    })
  })

  describe('revisionOf', () => {
    it('hashes bytes as SHA-256 in lowercase hexadecimal', () => {
      expect(revisionOf(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    })
  })
})
