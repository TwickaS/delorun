import { describe, expect, it } from 'vitest'
import { claudeLevelRun, ClaudeSandboxUnavailable } from '../src/levels.ts'

const ready = (): boolean => true
const absent = (): boolean => false

describe('claudeLevelRun', () => {
  it('confines Careful commands to the task folder with no network and switches the web tools off', () => {
    expect(claudeLevelRun('careful', '/task', 'linux', '/bin', ready)).toEqual({
      permissionMode: 'acceptEdits',
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: ['/task'] }, network: { allowedDomains: [] },
      },
      disallowedTools: ['WebFetch', 'WebSearch'],
    })
  })

  it('refuses Careful with the install line when the sandbox tools are missing', () => {
    const run = (): unknown => claudeLevelRun('careful', '/task', 'linux', '/bin', absent)
    expect(run).toThrow(ClaudeSandboxUnavailable)
    expect(run).toThrow('bwrap and socat. Install it with: sudo apt install bubblewrap socat')
  })

  it('lets Standard write in the task and temporary folders with the internet on, and asks the agent\'s own reviewer', () => {
    expect(claudeLevelRun('standard', '/task', 'darwin', undefined)).toMatchObject({
      permissionMode: 'auto',
      sandbox: { enabled: true, filesystem: { allowWrite: ['/task', '/tmp'] }, network: { allowedDomains: ['*'] } },
      disallowedTools: [],
    })
  })

  it('runs Standard without a sandbox, and says so, when the sandbox tools are missing', () => {
    expect(claudeLevelRun('standard', '/task', 'linux', '/bin', absent)).toEqual({
      permissionMode: 'acceptEdits', disallowedTools: [], sandboxUnavailable: true,
    })
  })

  it('sets nothing for the person\'s own settings and no sandbox for Unrestricted', () => {
    expect(claudeLevelRun('own', '/task', 'linux', '/bin', absent)).toEqual({ permissionMode: 'default', disallowedTools: [] })
    expect(claudeLevelRun('unrestricted', '/task', 'linux', '/bin', absent)).toEqual({
      permissionMode: 'bypassPermissions', sandbox: { enabled: false }, disallowedTools: [],
    })
  })
})
