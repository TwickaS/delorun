import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_CHOICES, chromeChannelCandidates, chromeChannelExecutable, launchedBrowser, parseBrowserChoice, processChromeChannelHost,
  type ChromeChannelHost,
} from '../src/chrome-channel.ts'

const LINUX = '/opt/google/chrome/chrome'
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function host(platform: NodeJS.Platform, present: readonly string[] = [], env: Record<string, string | undefined> = {}): ChromeChannelHost {
  return { platform, env, exists: path => present.includes(path) }
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

describe('Chrome channel lookup', () => {
  it('lists one fixed path on Linux and macOS and none on a platform the channel does not support', () => {
    expect(chromeChannelCandidates(host('linux'))).toEqual([LINUX])
    expect(chromeChannelCandidates(host('darwin'))).toEqual([MAC])
    expect(chromeChannelCandidates(host('freebsd'))).toEqual([])
    expect(chromeChannelExecutable(host('freebsd', [LINUX]))).toBeUndefined()
  })

  it('lists the Windows installation folders in Playwright\'s order and skips unset and empty variables', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', HOMEDRIVE: 'D:' }
    expect(chromeChannelCandidates(host('win32', [], env))).toEqual([
      'C:\\Users\\p\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(chromeChannelCandidates(host('win32', [], { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: '', HOMEDRIVE: '' }))).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(chromeChannelCandidates(host('win32'))).toEqual([])
  })

  it('answers the first candidate that exists and nothing when none does', () => {
    const env = { LOCALAPPDATA: 'C:\\L', PROGRAMFILES: 'C:\\P' }
    const second = 'C:\\P\\Google\\Chrome\\Application\\chrome.exe'
    expect(chromeChannelExecutable(host('win32', [second], env))).toBe(second)
    expect(chromeChannelExecutable(host('linux', [LINUX]))).toBe(LINUX)
    expect(chromeChannelExecutable(host('linux', ['/usr/bin/google-chrome']))).toBeUndefined()
  })

  it('launches Chrome under auto only when it is installed, and the named browser under chrome and chromium', () => {
    expect(launchedBrowser('auto', host('darwin', [MAC]))).toBe('chrome')
    expect(launchedBrowser('auto', host('darwin'))).toBe('chromium')
    expect(launchedBrowser('chrome', host('darwin'))).toBe('chrome')
    expect(launchedBrowser('chromium', host('darwin', [MAC]))).toBe('chromium')
    expect(launchedBrowser('auto')).toBe(chromeChannelExecutable() === undefined ? 'chromium' : 'chrome')
    expect(launchedBrowser('auto', host('darwin', [MAC]), '/custom/chromium')).toBe('chromium')
    expect(launchedBrowser('chrome', host('darwin', [MAC]), '/custom/chrome')).toBe('chrome')
  })

  it('reads an unset choice as auto and refuses anything that is not a choice', () => {
    expect(parseBrowserChoice(undefined)).toBe('auto')
    for (const choice of BROWSER_CHOICES) expect(parseBrowserChoice(choice)).toBe(choice)
    for (const value of ['firefox', '', null, 1, ['chrome']]) {
      expect(() => parseBrowserChoice(value)).toThrow('browser must be one of auto, chrome, chromium')
    }
  })

  it('tests this computer\'s files by access, without running them', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dsh-chrome-channel-'))
    folders.push(folder)
    const file = join(folder, 'chrome')
    await writeFile(file, 'not a program')
    await chmod(file, 0o600)
    const real = processChromeChannelHost()
    expect(real.platform).toBe(process.platform)
    expect(real.env).toBe(process.env)
    expect(real.exists(file)).toBe(true)
    expect(real.exists(join(folder, 'absent'))).toBe(false)
    expect(real.exists(join(file, 'under-a-file'))).toBe(false)
  })
})
