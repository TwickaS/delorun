import { describe, expect, it } from 'vitest'
import { ALLOW_STANDINS_VARIABLE, replicaOptions } from '../replica-options.ts'

describe('the replica plugins\' session policy', () => {
  it('refuses stand-ins unless the environment says exactly 1', () => {
    expect(replicaOptions({}).sessions.preview).toBe(false)
    for (const value of ['', '0', 'true', 'yes', ' 1', '1 ']) expect(replicaOptions({ [ALLOW_STANDINS_VARIABLE]: value }).sessions.preview, value).toBe(false)
    expect(replicaOptions({ [ALLOW_STANDINS_VARIABLE]: '1' }).sessions.preview).toBe(true)
  })

  it('does not read the process environment of the test run when the policy is built from an empty one', () => {
    process.env[ALLOW_STANDINS_VARIABLE] = '1'
    try {
      expect(replicaOptions({}).sessions.preview).toBe(false)
    } finally {
      delete process.env[ALLOW_STANDINS_VARIABLE]
    }
  })
})
