/**
 * The package root keeps every name that installed external-agent packs built for an earlier release import from it:
 * a pack's import of a name the root dropped fails at load, and the update's health check then refuses the release.
 */

import { describe, expect, it } from 'vitest'
import * as root from '../src/index.ts'

describe('the package root', () => {
  it('exports the names earlier Claude Code and Codex packs import', () => {
    const names = [
      'agentSignInFailureText',
      'isAgentSignInFailure',
      'NO_START_CAPABILITIES',
      'assertPositiveFinite',
      'assertUsableCwd',
      'settleRunResult',
      'subprocessRunHandle',
      'CLAUDE_SANDBOX_INSTALL_COMMAND',
      'missingClaudeSandboxTools',
      'SUBAGENT_SAFETY_LEVELS',
      'assertExternalDelegationConsent',
      'DELEGATION_CONSENT_PROVIDER_EXPORT',
      'findDelegationConsent',
      'limitExternalRunTime',
    ]
    expect(names.filter(name => !(name in root))).toEqual([])
  })
})
