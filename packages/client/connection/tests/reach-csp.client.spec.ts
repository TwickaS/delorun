/** The reach Content Security Policy's Trusted Types directives (C4). */

import { describe, expect, it } from 'vitest'
import { reachContentSecurityPolicy } from '../src/reach.ts'

describe('reachContentSecurityPolicy', () => {
  it("enforces Trusted Types for 'script' and allows exactly the two policies C4 names", () => {
    const policy = reachContentSecurityPolicy('n0nce-n0nce-n0nce-n0nce-n0nce')
    expect(policy).toContain("require-trusted-types-for 'script'")
    expect(policy).toContain('trusted-types default delo-plugin-loader')
    // The directive list names the default policy and the client module loader's policy, and nothing else.
    expect(/trusted-types ([^;]+)/.exec(policy)?.[1]).toBe('default delo-plugin-loader')
  })
})
