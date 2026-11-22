import { describe, expect, it } from 'vitest'
import { hostPathRefusal, translateWindowsPath } from '../src/windows-path.ts'

describe('translateWindowsPath', () => {
  it.each([
    ['C:\\x', '/mnt/c/x'],
    ['C:\\Users\\me\\My Documents\\notes 1.md', '/mnt/c/Users/me/My Documents/notes 1.md'],
    ['d:\\data\\a.txt', '/mnt/d/data/a.txt'],
    ['C:\\', '/mnt/c'],
    ['C:\\Users\\me\\\\notes.md', '/mnt/c/Users/me/notes.md'],
    ['C:\\日本語\\ファイル.md', '/mnt/c/日本語/ファイル.md'],
  ])('turns the drive path %s into %s', (nativePath, linuxPath) => {
    expect(translateWindowsPath(nativePath, 'Ubuntu')).toEqual({ ok: true, path: linuxPath })
  })

  it.each([
    ['\\\\wsl$\\Ubuntu\\home\\me\\notes.md', '/home/me/notes.md'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md', '/home/me/notes.md'],
    ['\\\\WSL$\\ubuntu\\tmp', '/tmp'],
    ['\\\\wsl$\\Ubuntu', '/'],
    ['\\\\wsl$\\Ubuntu\\', '/'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\me\\a:b.txt', '/home/me/a:b.txt'],
  ])('turns the path %s on the same distribution into %s', (nativePath, linuxPath) => {
    expect(translateWindowsPath(nativePath, 'Ubuntu')).toEqual({ ok: true, path: linuxPath })
  })

  it.each([
    ['another distribution', '\\\\wsl$\\Debian\\home\\me\\notes.md'],
    ['another distribution by prefix', '\\\\wsl$\\Ubuntu-24.04\\home\\me'],
    ['a network share', '\\\\server\\share\\notes.md'],
    ['a device path', '\\\\?\\C:\\x'],
    ['a device namespace', '\\\\.\\pipe\\x'],
    ['a relative drive path', 'C:notes.md'],
    ['a drive with no path', 'C:'],
    ['a relative path', 'notes\\a.md'],
    ['a Linux path', '/home/me/notes.md'],
    ['a stream name', 'C:\\x\\a.txt:hidden'],
    ['a parent segment', 'C:\\x\\..\\y'],
    ['a parent segment on the distribution', '\\\\wsl$\\Ubuntu\\home\\..\\etc'],
    ['a current-folder segment', 'C:\\x\\.\\y'],
    ['a control character', 'C:\\x\\a\u0007b'],
    ['a forward-slash drive path', 'C:/x/y'],
    ['an empty path', ''],
  ])('refuses %s', (_name, nativePath) => {
    expect(translateWindowsPath(nativePath, 'Ubuntu')).toEqual({ ok: false })
  })

  it('never produces a path with a backslash, a parent segment or a drive letter', () => {
    for (const nativePath of ['C:\\a\\b', '\\\\wsl$\\Ubuntu\\a\\b', 'Z:\\']) {
      const result = translateWindowsPath(nativePath, 'Ubuntu')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toMatch(/^\//u)
        expect(result.path).not.toMatch(/\\|\.\.|^[A-Za-z]:/u)
      }
    }
  })
})

describe('hostPathRefusal', () => {
  it('names the distribution, says what to do, and holds no path or link', () => {
    const message = hostPathRefusal('Ubuntu')
    expect(message).toContain('"Ubuntu"')
    expect(message).toContain('Windows drive')
    expect(message).not.toMatch(/https?:|token|\\\\/iu)
  })
})
