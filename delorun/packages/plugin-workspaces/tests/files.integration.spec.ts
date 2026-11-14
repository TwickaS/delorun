import { execFileSync } from 'node:child_process'
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseWalk, INSTRUCTIONS, InstructionsRefusedError, InvalidPathError, probeProcFd, readInstructions, repositoryOf, revisionOf, UnsupportedHostError, unavailableReason, writeInstructions, type Walk, type WalkOptions } from '../src/files.ts'

// Records the open calls, so a spec can read the flags and mode a temporary file is created with. Calls pass through.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const LIMIT = 64
const NONE = { text: null, revision: null }

// The workspace's path below the root, in every spec that does not nest the workspace.
const WORKSPACE = 'workspace'

// The walks this host runs. The proc walk needs /proc/self/fd, so it is left out where that directory is absent.
const WALKS: Walk[] = probeProcFd() ? ['proc', 'lstat'] : ['lstat']

let root: string
let dir: string

/**
 * Expect a promise to refuse with an instructions refusal of one code.
 * @param promise - the call under test.
 * @param code - the refusal code expected.
 * @returns when the call refuses with that code.
 */
async function expectRefusal<T>(promise: Promise<T>, code: 'conflict' | 'too-large' | 'unavailable'): Promise<void> {
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

// The real open, which the mocked open delegates to.
let actualOpen: typeof open

beforeAll(async () => {
  actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
})

afterAll(() => {
  vi.mocked(open).mockImplementation(actualOpen)
})

/**
 * Make a change to the workspace at one point of the module's walk, so a spec fixes the interleaving instead of racing for it.
 * The first open of a path that `matches` runs `change` before the open, or once the descriptor is opened and before its first `stat`.
 * @param matches - whether an opened path is the one to stop at.
 * @param when - `before-open` for a name that changes after the module checked it, `after-open` for a file that changes while the module holds it.
 * @param change - the change.
 */
function changeAt(matches: (path: string) => boolean, when: 'before-open' | 'after-open', change: () => void): void {
  let done = false
  vi.mocked(open).mockImplementation(async (...args) => {
    const hit = !done && matches(String(args[0]))
    if (hit) done = true
    if (hit && when === 'before-open') change()
    const handle = await actualOpen(...args)
    if (hit && when === 'after-open') {
      const stat = handle.stat.bind(handle)
      Object.defineProperty(handle, 'stat', { value: () => { change(); return stat() } })
    }
    return handle
  })
}

/**
 * Whether an opened path names the instructions file, whether by the checked path or through a held descriptor.
 * @param path - the path the module opens.
 * @returns true for `AGENTS.md` itself, false for a directory or a temporary file.
 */
function isInstructionsPath(path: string): boolean {
  return path.endsWith(`/${INSTRUCTIONS}`)
}

/**
 * Whether an opened path is the temporary file a write creates beside `AGENTS.md`.
 * @param path - the path the module opens.
 * @returns true for the temporary file.
 */
function isTemporaryPath(path: string): boolean {
  return path.includes(`/.${INSTRUCTIONS}.delorun-`)
}

/**
 * Give each test of the enclosing suite a new workspace directory under a new temporary root, removed after the test.
 */
function freshWorkspace(): void {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delorun-files-'))
    dir = join(root, WORKSPACE)
    mkdirSync(dir)
    vi.mocked(open).mockClear()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

describe('walk selection', () => {
  it('chooses the lstat walk without /proc/self/fd and the proc walk with it', () => {
    expect(chooseWalk(false)).toBe('lstat')
    expect(chooseWalk(true)).toBe('proc')
  })
})

describe('unsupported hosts', () => {
  freshWorkspace()

  it('refuses every call with UnsupportedHostError on Windows, and creates no file', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(readInstructions(root, WORKSPACE, LIMIT)).rejects.toBeInstanceOf(UnsupportedHostError)
      await expect(writeInstructions(root, WORKSPACE, 'x', null, LIMIT)).rejects.toBeInstanceOf(UnsupportedHostError)
      await expect(repositoryOf(root, WORKSPACE)).rejects.toBeInstanceOf(UnsupportedHostError)
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
    }
    expect(readdirSync(dir)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('instructions files', () => {
  describe('a host without /proc/self/fd', () => {
    freshWorkspace()

    it('refuses a symbolic link named AGENTS.md and a symbolic link as the workspace directory under chooseWalk(false)', async () => {
      const options = { walk: chooseWalk(false) }
      const outside = join(root, 'outside.md')
      writeFileSync(outside, 'secret')
      symlinkSync(outside, join(dir, INSTRUCTIONS))
      expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
      await expectRefusal(writeInstructions(root, WORKSPACE, 'planted', null, LIMIT, options), 'conflict')
      await expectRefusal(writeInstructions(root, WORKSPACE, 'planted', revisionOf(Buffer.from('secret')), LIMIT, options), 'conflict')
      expect(readFileSync(outside, 'utf8')).toBe('secret')

      const real = join(root, 'real')
      mkdirSync(real)
      writeFileSync(join(real, INSTRUCTIONS), 'secret')
      const linked = join(root, 'linked')
      symlinkSync(real, linked)
      expect(await readInstructions(root, 'linked', LIMIT, options)).toEqual(NONE)
      await expectRefusal(writeInstructions(root, 'linked', 'planted', null, LIMIT, options), 'conflict')
      await expectRefusal(writeInstructions(root, 'linked', 'planted', revisionOf(Buffer.from('secret')), LIMIT, options), 'conflict')
      expect(readFileSync(join(real, INSTRUCTIONS), 'utf8')).toBe('secret')
    })
  })

  describe.each(WALKS)('on the %s walk', (walk) => {
    const options = { walk }

    freshWorkspace()

    describe('readInstructions', () => {
      it('reads a regular file as text, with the SHA-256 of its bytes as the revision', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), 'Use pnpm.')
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
      })

      it('reads a missing file and a missing workspace directory as no file', async () => {
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
        expect(await readInstructions(root, 'missing', LIMIT, options)).toEqual(NONE)
      })

      it('reads a symbolic link named AGENTS.md as no file, never the file it points to', async () => {
        const outside = join(root, 'outside.md')
        writeFileSync(outside, 'secret')
        symlinkSync(outside, join(dir, INSTRUCTIONS))
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
      })

      it('reads nothing through a symbolic link at the workspace directory', async () => {
        const real = join(root, 'real')
        mkdirSync(real)
        writeFileSync(join(real, INSTRUCTIONS), 'secret')
        const linked = join(root, 'linked')
        symlinkSync(real, linked)
        expect(await readInstructions(root, 'linked', LIMIT, options)).toEqual(NONE)
      })

      it('reads a directory named AGENTS.md as no file', async () => {
        mkdirSync(join(dir, INSTRUCTIONS))
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
      })

      it('reads a FIFO named AGENTS.md as no file without waiting for a writer', async () => {
        execFileSync('mkfifo', [join(dir, INSTRUCTIONS)], { timeout: 30_000 })
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
      })

      it('refuses a file longer than the limit in UTF-8 bytes, though it has fewer characters', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(5))
        await expectRefusal(readInstructions(root, WORKSPACE, 12, options), 'too-large')
      })

      it('reads a file whose UTF-8 bytes equal the limit', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(4))
        expect(await readInstructions(root, WORKSPACE, 12, options)).toEqual({ text: '€'.repeat(4), revision: revisionOf(Buffer.from('€'.repeat(4))) })
      })
    })

    describe('writeInstructions', () => {
      it('writes a new file with mode 0644, reads it back, and leaves no temporary file', async () => {
        await writeInstructions(root, WORKSPACE, 'Use pnpm.', null, LIMIT, options)
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
        expect(statSync(join(dir, INSTRUCTIONS)).mode & 0o777).toBe(0o644)
        expect(readdirSync(dir)).toEqual([INSTRUCTIONS])
      })

      it('creates the temporary file with mode 0600 and exclusive creation', async () => {
        await writeInstructions(root, WORKSPACE, 'Use pnpm.', null, LIMIT, options)
        const temporary = vi.mocked(open).mock.calls.filter(([path]) => String(path).includes(`/.${INSTRUCTIONS}.delorun-`))
        expect(temporary).toHaveLength(1)
        const [, flags, mode] = temporary[0] ?? []
        expect(mode).toBe(0o600)
        expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL)
      })

      it('replaces the file when the expected revision matches', async () => {
        await writeInstructions(root, WORKSPACE, 'one', null, LIMIT, options)
        const { revision } = await readInstructions(root, WORKSPACE, LIMIT, options)
        await writeInstructions(root, WORKSPACE, 'two', revision, LIMIT, options)
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'two', revision: revisionOf(Buffer.from('two')) })
      })

      it('refuses a stale revision, and a null revision when the file exists, and leaves the file as it was', async () => {
        await writeInstructions(root, WORKSPACE, 'one', null, LIMIT, options)
        await expectRefusal(writeInstructions(root, WORKSPACE, 'two', revisionOf(Buffer.from('zero')), LIMIT, options), 'conflict')
        await expectRefusal(writeInstructions(root, WORKSPACE, 'two', null, LIMIT, options), 'conflict')
        expect(onDisk(INSTRUCTIONS)).toBe('one')
      })

      it('removes the file for empty text when the revision matches', async () => {
        await writeInstructions(root, WORKSPACE, 'Use pnpm.', null, LIMIT, options)
        const { revision } = await readInstructions(root, WORKSPACE, LIMIT, options)
        await writeInstructions(root, WORKSPACE, '', revision, LIMIT, options)
        expect(existsSync(join(dir, INSTRUCTIONS))).toBe(false)
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
      })

      it('succeeds without a change for empty text when no file exists and the revision is null', async () => {
        await expect(writeInstructions(root, WORKSPACE, '', null, LIMIT, options)).resolves.toBeUndefined()
        expect(readdirSync(dir)).toEqual([])
      })

      it('refuses empty text with a stale revision and keeps the file', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), 'Use pnpm.')
        await expectRefusal(writeInstructions(root, WORKSPACE, '', null, LIMIT, options), 'conflict')
        await expectRefusal(writeInstructions(root, WORKSPACE, '', revisionOf(Buffer.from('other')), LIMIT, options), 'conflict')
        expect(onDisk(INSTRUCTIONS)).toBe('Use pnpm.')
      })

      it('refuses a write through a symbolic link named AGENTS.md and leaves the file it points to unchanged', async () => {
        const outside = join(root, 'outside.md')
        writeFileSync(outside, 'secret')
        symlinkSync(outside, join(dir, INSTRUCTIONS))
        await expectRefusal(writeInstructions(root, WORKSPACE, 'planted', null, LIMIT, options), 'conflict')
        await expectRefusal(writeInstructions(root, WORKSPACE, 'planted', revisionOf(Buffer.from('secret')), LIMIT, options), 'conflict')
        await expectRefusal(writeInstructions(root, WORKSPACE, '', null, LIMIT, options), 'conflict')
        expect(readFileSync(outside, 'utf8')).toBe('secret')
        expect(lstatSync(join(dir, INSTRUCTIONS)).isSymbolicLink()).toBe(true)
      })

      it('refuses a write into a workspace directory that is a symbolic link and leaves the real directory unchanged', async () => {
        const real = join(root, 'real')
        mkdirSync(real)
        writeFileSync(join(real, INSTRUCTIONS), 'secret')
        const linked = join(root, 'linked')
        symlinkSync(real, linked)
        await expectRefusal(writeInstructions(root, 'linked', 'planted', null, LIMIT, options), 'conflict')
        await expectRefusal(writeInstructions(root, 'linked', 'planted', revisionOf(Buffer.from('secret')), LIMIT, options), 'conflict')
        expect(readFileSync(join(real, INSTRUCTIONS), 'utf8')).toBe('secret')
      })

      it('refuses to replace a directory named AGENTS.md and to wait on a FIFO of that name', async () => {
        mkdirSync(join(dir, INSTRUCTIONS))
        await expectRefusal(writeInstructions(root, WORKSPACE, 'x', null, LIMIT, options), 'conflict')
        expect(statSync(join(dir, INSTRUCTIONS)).isDirectory()).toBe(true)
        rmSync(join(dir, INSTRUCTIONS), { recursive: true })
        execFileSync('mkfifo', [join(dir, INSTRUCTIONS)], { timeout: 30_000 })
        await expectRefusal(writeInstructions(root, WORKSPACE, 'x', null, LIMIT, options), 'conflict')
      })

      it('lets one of two concurrent writes that both expect no file succeed, and refuses the other as a conflict', async () => {
        const results = await Promise.allSettled([writeInstructions(root, WORKSPACE, 'first', null, LIMIT, options), writeInstructions(root, WORKSPACE, 'second', null, LIMIT, options)])
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]?.reason).toBeInstanceOf(InstructionsRefusedError)
        expect(rejected[0]?.reason).toHaveProperty('code', 'conflict')
      })

      it('queues writes through two paths to one directory together', async () => {
        symlinkSync(root, join(root, 'alias'))
        const results = await Promise.allSettled([
          writeInstructions(root, WORKSPACE, 'first', null, LIMIT, options),
          writeInstructions(join(root, 'alias'), WORKSPACE, 'second', null, LIMIT, options),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      })

      it('refuses text longer than the limit in UTF-8 bytes, though it has fewer characters', async () => {
        await expectRefusal(writeInstructions(root, WORKSPACE, 'a'.repeat(LIMIT + 1), null, LIMIT, options), 'too-large')
        await expectRefusal(writeInstructions(root, WORKSPACE, '€'.repeat(5), null, 12, options), 'too-large')
        expect(readdirSync(dir)).toEqual([])
      })

      it('accepts multi-byte text whose UTF-8 bytes equal the limit', async () => {
        await writeInstructions(root, WORKSPACE, '€'.repeat(4), null, 12, options)
        expect(await readInstructions(root, WORKSPACE, 12, options)).toEqual({ text: '€'.repeat(4), revision: revisionOf(Buffer.from('€'.repeat(4))) })
      })

      it('refuses a write over an existing file longer than the limit, since that file was never read', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), '€'.repeat(5))
        await expectRefusal(writeInstructions(root, WORKSPACE, 'x', null, 12, options), 'conflict')
      })

      it('refuses to create the file in a missing workspace directory and treats empty text there as a no-op', async () => {
        await expect(writeInstructions(root, 'missing', 'x', null, LIMIT, options)).rejects.toThrow('does not exist')
        await expect(writeInstructions(root, 'missing', '', null, LIMIT, options)).resolves.toBeUndefined()
        await expectRefusal(writeInstructions(root, 'missing', '', 'stale', LIMIT, options), 'conflict')
      })
    })

    describe('nested workspaces', () => {
      it('opens the root by its path, so a link in the root path is followed', async () => {
        const alias = join(root, 'alias')
        symlinkSync(root, alias)
        await writeInstructions(alias, WORKSPACE, 'Use pnpm.', null, LIMIT, options)
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
      })

      it('reads and writes a workspace nested in real directories', async () => {
        mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
        await writeInstructions(root, 'a/b/c', 'Use pnpm.', null, LIMIT, options)
        expect(await readInstructions(root, 'a/b/c', LIMIT, options)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
        expect(readFileSync(join(root, 'a', 'b', 'c', INSTRUCTIONS), 'utf8')).toBe('Use pnpm.')
      })

      it('refuses a symbolic link at a middle name: reads no file, and a write leaves the file it points to unchanged', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'delorun-outside-'))
        try {
          mkdirSync(join(outside, 'c'))
          writeFileSync(join(outside, 'c', INSTRUCTIONS), 'secret')
          mkdirSync(join(root, 'a'))
          symlinkSync(outside, join(root, 'a', 'b'))
          const secret = revisionOf(Buffer.from('secret'))
          expect(await readInstructions(root, 'a/b/c', LIMIT, options)).toEqual(NONE)
          await expectRefusal(writeInstructions(root, 'a/b/c', 'planted', null, LIMIT, options), 'conflict')
          await expectRefusal(writeInstructions(root, 'a/b/c', 'planted', secret, LIMIT, options), 'conflict')
          await expectRefusal(writeInstructions(root, 'a/b/c', '', secret, LIMIT, options), 'conflict')
          expect(readFileSync(join(outside, 'c', INSTRUCTIONS), 'utf8')).toBe('secret')
        } finally {
          rmSync(outside, { recursive: true, force: true })
        }
      })

      it('refuses a regular file at a middle name: reads no file, and a write refuses it', async () => {
        writeFileSync(join(root, 'a'), 'not a folder')
        expect(await readInstructions(root, 'a/b/c', LIMIT, options)).toEqual(NONE)
        await expectRefusal(writeInstructions(root, 'a/b/c', 'planted', null, LIMIT, options), 'conflict')
        expect(readFileSync(join(root, 'a'), 'utf8')).toBe('not a folder')
      })

      it('reads a missing middle name as no file, and a write into it reports the missing folder', async () => {
        expect(await readInstructions(root, 'a/b/c', LIMIT, options)).toEqual(NONE)
        await expect(writeInstructions(root, 'a/b/c', 'x', null, LIMIT, options)).rejects.toThrow('does not exist')
        expect(readdirSync(root)).toEqual([WORKSPACE])
      })
    })

    describe('repositoryOf', () => {
      it('reads the origin URL and the checked-out branch', async () => {
        gitDirectory('ref: refs/heads/main\n', remoteConfig('https://github.com/acme/widgets.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: 'main' })
      })

      it('shows no origin for a URL with a user name or password', async () => {
        gitDirectory('ref: refs/heads/main\n', remoteConfig('https://user:password@github.com/acme/widgets.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: null, branch: 'main' })
        writeFileSync(join(dir, '.git', 'config'), remoteConfig('https://token@github.com/acme/widgets.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: null, branch: 'main' })
      })

      it('drops the query and fragment from an origin URL', async () => {
        gitDirectory('ref: refs/heads/main\n', remoteConfig('https://github.com/acme/widgets.git?access=abc#top'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: 'main' })
      })

      it('keeps an address that is not a URL as written', async () => {
        gitDirectory('ref: refs/heads/main\n', remoteConfig('git@github.com:acme/widgets.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: 'git@github.com:acme/widgets.git', branch: 'main' })
      })

      it('shows no branch for a detached HEAD', async () => {
        gitDirectory('0123456789abcdef0123456789abcdef01234567\n', remoteConfig('https://github.com/acme/widgets.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: 'https://github.com/acme/widgets.git', branch: null })
      })

      it('shows no repository without a .git directory', async () => {
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: null, branch: null })
      })

      it('shows no repository for a .git file, such as a linked worktree', async () => {
        writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: null, branch: null })
      })

      it('shows no repository for a .git symbolic link', async () => {
        const real = join(root, 'real.git')
        mkdirSync(real)
        writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n')
        writeFileSync(join(real, 'config'), remoteConfig('https://github.com/acme/widgets.git'))
        symlinkSync(real, join(dir, '.git'))
        expect(await repositoryOf(root, WORKSPACE, options)).toEqual({ origin: null, branch: null })
      })
    })

    describe('a name that changes while a call runs', () => {
      afterEach(() => {
        vi.mocked(open).mockImplementation(actualOpen)
      })

      it('reads the file it opened, not the file that takes its name after the open', async () => {
        writeFileSync(join(dir, INSTRUCTIONS), 'original')
        changeAt(isInstructionsPath, 'after-open', () => {
          renameSync(join(dir, INSTRUCTIONS), join(dir, 'moved.md'))
          writeFileSync(join(dir, INSTRUCTIONS), 'swapped')
        })
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'original', revision: revisionOf(Buffer.from('original')) })
        expect(onDisk(INSTRUCTIONS)).toBe('swapped')
      })

      it('reads no file when a symbolic link takes the name after the name was checked', async () => {
        const outside = join(root, 'outside.md')
        writeFileSync(outside, 'secret')
        writeFileSync(join(dir, INSTRUCTIONS), 'original')
        changeAt(isInstructionsPath, 'before-open', () => {
          rmSync(join(dir, INSTRUCTIONS))
          symlinkSync(outside, join(dir, INSTRUCTIONS))
        })
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual(NONE)
        expect(readFileSync(outside, 'utf8')).toBe('secret')
      })

      it('replaces a symbolic link that takes the name after the revision check, and leaves the file it points to unchanged', async () => {
        const outside = join(root, 'outside.md')
        writeFileSync(outside, 'secret')
        writeFileSync(join(dir, INSTRUCTIONS), 'original')
        changeAt(isTemporaryPath, 'before-open', () => {
          rmSync(join(dir, INSTRUCTIONS))
          symlinkSync(outside, join(dir, INSTRUCTIONS))
        })
        await writeInstructions(root, WORKSPACE, 'replacement', revisionOf(Buffer.from('original')), LIMIT, options)
        expect(readFileSync(outside, 'utf8')).toBe('secret')
        expect(lstatSync(join(dir, INSTRUCTIONS)).isFile()).toBe(true)
        expect(onDisk(INSTRUCTIONS)).toBe('replacement')
        expect(readdirSync(dir)).toEqual([INSTRUCTIONS])
      })

      it.runIf(walk === 'proc')('reads the workspace it held when a link replaces its directory, and writes there too', async () => {
        const outside = join(root, 'outside')
        mkdirSync(outside)
        writeFileSync(join(outside, INSTRUCTIONS), 'secret')
        writeFileSync(join(dir, INSTRUCTIONS), 'original')
        const swapDirectory = (): void => {
          renameSync(dir, `${dir}-moved`)
          symlinkSync(outside, dir)
        }
        changeAt(isInstructionsPath, 'before-open', swapDirectory)
        expect(await readInstructions(root, WORKSPACE, LIMIT, options)).toEqual({ text: 'original', revision: revisionOf(Buffer.from('original')) })
        rmSync(dir)
        renameSync(`${dir}-moved`, dir)
        changeAt(isTemporaryPath, 'before-open', swapDirectory)
        await writeInstructions(root, WORKSPACE, 'replacement', revisionOf(Buffer.from('original')), LIMIT, options)
        expect(readFileSync(join(`${dir}-moved`, INSTRUCTIONS), 'utf8')).toBe('replacement')
        expect(readdirSync(outside)).toEqual([INSTRUCTIONS])
        expect(readFileSync(join(outside, INSTRUCTIONS), 'utf8')).toBe('secret')
      })
    })
  })

  describe('a forced proc walk whose descriptor directory cannot name the held descriptors', () => {
    freshWorkspace()

    it('refuses reads, writes and repository reads as unavailable, never as no file', async () => {
      writeFileSync(join(dir, INSTRUCTIONS), 'Use pnpm.')
      const procRoot = join(root, 'no-such-descriptors')
      const options: WalkOptions = { walk: 'proc', procRoot }
      const refusal = await readInstructions(root, WORKSPACE, LIMIT, options).then(() => undefined, (reason: unknown) => reason)
      expect(refusal).toHaveProperty('message', unavailableReason(procRoot, Object.assign(new Error('missing'), { code: 'ENOENT' })))
      await expectRefusal(writeInstructions(root, WORKSPACE, 'planted', null, LIMIT, options), 'unavailable')
      await expectRefusal(repositoryOf(root, WORKSPACE, options), 'unavailable')
      expect(onDisk(INSTRUCTIONS)).toBe('Use pnpm.')
    })

    it('refuses a missing workspace folder as unavailable as well', async () => {
      const options: WalkOptions = { walk: 'proc', procRoot: join(root, 'no-such-descriptors') }
      await expectRefusal(readInstructions(root, 'missing', LIMIT, options), 'unavailable')
    })

    it('refuses when the descriptor directory exists but does not name the held descriptors', async () => {
      const empty = join(root, 'empty-descriptors')
      mkdirSync(empty)
      const options: WalkOptions = { walk: 'proc', procRoot: empty }
      await expectRefusal(readInstructions(root, WORKSPACE, LIMIT, options), 'unavailable')
    })
  })

  describe('relative directories', () => {
    freshWorkspace()

    it('treats an empty relative directory as the root itself', async () => {
      await writeInstructions(root, '', 'Use pnpm.', null, LIMIT)
      expect(readFileSync(join(root, INSTRUCTIONS), 'utf8')).toBe('Use pnpm.')
      expect(await readInstructions(root, '', LIMIT)).toEqual({ text: 'Use pnpm.', revision: revisionOf(Buffer.from('Use pnpm.')) })
    })

    it('refuses an absolute path and a name that is empty, `.`, `..` or holds a NUL byte, and touches no file', async () => {
      for (const value of ['/workspace', 'workspace/', 'a//b', './workspace', 'a/../workspace', '../workspace', 'a\0b']) {
        await expect(readInstructions(root, value, LIMIT)).rejects.toBeInstanceOf(InvalidPathError)
        await expect(writeInstructions(root, value, 'x', null, LIMIT)).rejects.toBeInstanceOf(InvalidPathError)
        await expect(repositoryOf(root, value)).rejects.toBeInstanceOf(InvalidPathError)
      }
      expect(readdirSync(root)).toEqual([WORKSPACE])
    })
  })

  describe('revisionOf', () => {
    it('hashes bytes as SHA-256 in lowercase hexadecimal', () => {
      expect(revisionOf(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    })
  })
})
