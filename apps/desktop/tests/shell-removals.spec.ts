import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'

/** Delorun's shell does not ship the DeepSeek account welcome window, the mandatory-update policy or the `dsh` command (L157). */
const APP = new URL('../', import.meta.url)

const read = (path: string): string => readFileSync(new URL(path, APP), 'utf8')

/** Every file under a folder of the app, as paths relative to the app, without build output. */
function filesUnder(folder: string, extensions: readonly string[]): string[] {
  return (readdirSync(new URL(`${folder}/`, APP), { recursive: true }) as string[])
    .filter(name => extensions.some(extension => name.endsWith(extension)))
    .map(name => `${folder}/${name.replaceAll('\\', '/')}`)
}

describe('the DeepSeek account welcome window and API-key onboarding page are gone', () => {
  it.each([
    'src/welcome-window.ts', 'src/welcome-api.ts', 'src/welcome-backend.ts', 'src/account-backend.ts', 'src/preload-welcome.ts',
    'src/client/WelcomePage.tsx', 'src/client/welcome.tsx', 'renderer/welcome.html', 'renderer/welcome.css',
    'renderer/assets/welcome-brand.svg', 'renderer/policy-login-loading.html',
  ])('has no %s', (path) => {
    expect(existsSync(new URL(path, APP))).toBe(false)
  })

  it('has no welcome, onboarding-window or account channel in the private IPC names', () => {
    const names = Object.entries(DESKTOP_IPC).flat().join(' ')
    expect(names).not.toMatch(/welcome|account|login|policy/iu)
  })
})

describe('the mandatory-update policy fetched from DeepSeek\'s origin is gone', () => {
  it.each([
    'src/mandatory-update-policy.ts', 'src/mandatory-update-window.ts', 'src/mandatory-update-ipc.ts', 'src/policy-test-auth.ts',
    'src/preload-mandatory.ts', 'src/preload-mandatory-overlay.ts', 'src/update-attention.ts',
    'renderer/mandatory-update.html', 'renderer/mandatory-update.js', 'renderer/mandatory-update.css', 'renderer/mandatory-update-frame.js',
    'scripts/desktop-policy-environment.mjs', 'scripts/desktop-policy-environment.d.mts',
  ])('has no %s', (path) => {
    expect(existsSync(new URL(path, APP))).toBe(false)
  })

  it('has no policy variable in the packaging scripts, their examples or the build metadata', () => {
    const files = [...filesUnder('scripts', ['.mjs', '.ts']), '.env.windows.example', '.env.macos.example',
      ...filesUnder('config', ['.example'])]
    for (const file of files) expect(read(file), file).not.toMatch(/MANDATORY_UPDATE|dshMandatoryUpdatePolicy|resolveDesktopPolicy/u)
  })

  it('has no preload or bundle entry for the removed windows', () => {
    const bundle = read('tsdown.config.ts') + read('scripts/electron-builder-config.mjs')
    expect(bundle).not.toMatch(/preload-(welcome|mandatory)|lib\/welcome|mandatory-update|welcome-window|command-manager/u)
    expect(bundle).toContain('lib/shell/**/*')
  })
})

describe('the shell reaches no DeepSeek-run service', () => {
  it('names no DeepSeek origin in its source, so no account, policy or login page can be loaded', () => {
    for (const file of filesUnder('src', ['.ts'])) expect(read(file), file).not.toMatch(/deepseek\.com|deepseek\.ai\/|mandatory-update|welcome/iu)
  })
})

describe('the dsh command registration is gone', () => {
  it.each([
    'src/command-installation.ts', 'src/command-management.ts', 'src/command-manager-entry.ts', 'scripts/command-path.ps1',
  ])('has no %s', (path) => {
    expect(existsSync(new URL(path, APP))).toBe(false)
  })

  it('registers no dsh link scheme and edits no PATH', () => {
    for (const file of filesUnder('src', ['.ts'])) {
      const source = read(file)
      expect(source, file).not.toMatch(/setAsDefaultProtocolClient\(\s*['"]dsh['"]/u)
      expect(source, file).not.toMatch(/dsh:\/\//u)
      expect(source, file).not.toMatch(/setx\s+PATH/u)
    }
  })
})
