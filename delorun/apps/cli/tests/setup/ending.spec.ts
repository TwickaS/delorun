import { describe, expect, it } from 'vitest'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delorun/contract-setup-answers'
import { FIRST_CHAT_PAGE, foregroundEnding, installLine, isProductionChannel, launcherVersion, nextSteps } from '../../src/setup/ending.ts'

const KEY_SET = { DEEPSEEK_API_KEY: 'env-key' }
const DEEPSEEK_ENV: SetupAnswers['modelProvider'] = { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null }

/** @returns the next steps of a profile with the answers that differ from the defaults. */
function steps(answers: Partial<SetupAnswers>, env: Record<string, string> = KEY_SET, profile = 'default'): string {
  return nextSteps({ profile, answers: { ...SETUP_DEFAULTS, modelProvider: DEEPSEEK_ENV, ...answers }, env })
}

describe('the launcher version', () => {
  it('reads the version the launcher set, and no version that is not a semantic version', () => {
    expect(launcherVersion({ DELORUN_LAUNCHER_VERSION: '0.1.0' })).toBe('0.1.0')
    expect(launcherVersion({ DELORUN_LAUNCHER_VERSION: 'latest' })).toBeUndefined()
    expect(launcherVersion({})).toBeUndefined()
    expect(installLine('0.1.0')).toBe('npm install -g delorun@0.1.0')
  })
})

describe('the next steps', () => {
  it('print the sandbox fix when the check found the sandbox cannot run, and nothing when it passes', () => {
    const answers = { ...SETUP_DEFAULTS, modelProvider: DEEPSEEK_ENV }
    const message = 'bubblewrap (bwrap) is not installed, so every sandboxed command is refused while /run/user/1000 exists; install the bubblewrap package (on Debian or Ubuntu: sudo apt install bubblewrap), then restart Delorun.'
    const failed = nextSteps({ profile: 'default', answers, env: KEY_SET, sandbox: { name: 'sandbox', status: 'fail', message } })
    expect(failed).toContain(`\nSandbox: ${message}\n\nChange an answer later`)
    const passed = nextSteps({ profile: 'default', answers, env: KEY_SET, sandbox: { name: 'sandbox', status: 'pass', message: 'ok' } })
    expect(passed).not.toContain('Sandbox:')
    expect(passed).toBe(nextSteps({ profile: 'default', answers, env: KEY_SET }))
  })

  it('print how to start and open the studio, the install guide first-chat section and how to change an answer, and nothing about a process', () => {
    const text = steps({})
    expect(text).toBe([
      'Delorun is set up. Nothing is running yet.',
      'Studio: http://127.0.0.1:3080',
      '',
      'Next:',
      '  1. Start Delorun and open the studio: delorun',
      `     Send a first message in a new chat. The install guide's section on your first chat walks through it: ${FIRST_CHAT_PAGE}`,
      '',
      'Change an answer later: delorun setup <section> (delorun setup --list shows the sections).',
      'If something looks wrong: delorun doctor.',
      '',
    ].join('\n'))
    expect(text).not.toMatch(/process|start id|profiles\//u)
  })

  it('name the profile in every command when it is not the default', () => {
    const text = steps({}, KEY_SET, 'work')
    expect(text).toContain('delorun --profile work\n')
    expect(text).toContain('delorun setup <section> --profile work')
    expect(text).toContain('delorun doctor --profile work')
  })

  it('put the install of the command first when the launcher started the run', () => {
    const text = steps({}, { ...KEY_SET, DELORUN_LAUNCHER_VERSION: '0.1.0' })
    expect(text).toContain('  1. Install the delorun command, which npx does not keep:\n     npm install -g delorun@0.1.0\n     If npm refuses for lack of permission, run npm install -g --prefix ~/.local delorun@0.1.0 and add ~/.local/bin to your PATH.\n  2. Start Delorun')
  })

  it('keep the command from the package file when the launcher was built for another release channel', () => {
    const text = nextSteps({ profile: 'default', answers: { ...SETUP_DEFAULTS, modelProvider: DEEPSEEK_ENV }, env: { ...KEY_SET, DELORUN_LAUNCHER_VERSION: '0.1.0-rc.1' }, channelOrigin: 'http://127.0.0.1:18080' })
    expect(text).toContain('  1. Keep the delorun command, which npx does not keep: 0.1.0-rc.1 is not on the npm registry, so install the package file this launcher came from:\n     npm install -g ./delorun-0.1.0-rc.1.tgz\n     If npm refuses for lack of permission, run npm install -g --prefix ~/.local ./delorun-0.1.0-rc.1.tgz and add ~/.local/bin to your PATH.\n  2. Start Delorun')
    expect(text).not.toContain('delorun@0.1.0-rc.1')
  })

  it('ask for a key first when no provider was chosen, and name the variable when it is unset', () => {
    expect(steps({ modelProvider: null })).toContain('  1. Add a model key first: delorun setup key\n  2. Start')
    expect(steps({}, {})).toContain('  1. Set DEEPSEEK_API_KEY in your terminal, then run delorun stop and delorun start if Delorun is running. It is the DeepSeek key you chose.')
    expect(steps({ modelProvider: { ...DEEPSEEK_ENV as NonNullable<typeof DEEPSEEK_ENV>, credential: { source: 'prompt' } } }, {})).not.toContain('Set DEEPSEEK_API_KEY')
  })

  it('print the headless command and no studio start for scripts and automation', () => {
    const text = steps({ useCase: 'automation' })
    expect(text).toContain('  1. Run a task from a script or CI: delorun headless "your task"')
    expect(text).not.toContain('first-chat')
  })

  it('print the device approval only when phone access is on', () => {
    expect(steps({ useCase: 'remote', reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } })).toContain('  2. Add your phone or another device: delorun devices approve, then type the code it shows.')
    for (const useCase of ['remote', 'local'] as const) expect(steps({ useCase })).not.toMatch(/phone|Remote access|devices approve/u)
  })

  it('name the chosen port in the studio address', () => {
    expect(steps({ profile: { name: null, port: 3123 } })).toContain('Studio: http://127.0.0.1:3123\n')
  })
})

describe('the ending of a run that started Delorun', () => {
  it('names the profile in each command and shows the sandbox fix first', () => {
    expect(foregroundEnding('default', undefined)).toBe([
      '',
      'Delorun runs in this terminal. Ctrl+C stops it.',
      'To keep it running after you close the terminal: delorun start --background',
      '(or Settings → General → How Delorun runs).',
      'Change an answer later: delorun setup <section> (delorun setup --list)',
      'If something looks wrong: delorun doctor',
      '',
    ].join('\n'))
    const text = foregroundEnding('work', { name: 'sandbox', status: 'fail', message: 'bwrap missing' })
    expect(text.startsWith('\nSandbox: bwrap missing\n\nDelorun runs in this terminal.')).toBe(true)
    expect(text).toContain('delorun start --profile work --background')
    expect(text).toContain('delorun doctor --profile work\n')
  })

  it('install the npm package, not a package file, for the production launcher whose channel origin is recorded', () => {
    for (const channelOrigin of ['https://releases.delorun.com', 'https://releases.delorun.com/']) {
      const text = nextSteps({ profile: 'default', answers: { ...SETUP_DEFAULTS, modelProvider: DEEPSEEK_ENV }, env: { ...KEY_SET, DELORUN_LAUNCHER_VERSION: '0.1.0' }, channelOrigin })
      expect(text).toContain('  1. Install the delorun command, which npx does not keep:\n     npm install -g delorun@0.1.0\n')
      expect(text).not.toMatch(/not on the npm registry|\.tgz/u)
    }
  })

  it('tell the production origin from the origin of another channel', () => {
    expect(isProductionChannel(undefined)).toBe(true)
    expect(isProductionChannel('https://releases.delorun.com')).toBe(true)
    expect(isProductionChannel('https://releases.delorun.com.example.org')).toBe(false)
    expect(isProductionChannel('https://releases.delo.run')).toBe(false)
    expect(isProductionChannel('http://127.0.0.1:18080')).toBe(false)
  })

  it('print no remote-access step for "Just me" with remote access off, and the device step when it was chosen', () => {
    const local = steps({ useCase: 'local' })
    expect(local).not.toMatch(/phone|devices approve|Remote access|Tailscale/u)
    const chosen = steps({ useCase: 'local', reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } })
    expect(chosen).toContain('  2. Add your phone or another device: delorun devices approve, then type the code it shows.')
  })
})
