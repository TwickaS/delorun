/** The reach Content Security Policy's Trusted Types directives (C4). */

import { describe, expect, it } from 'vitest'
import { reachContentSecurityPolicy } from '../src/reach.ts'

describe('reachContentSecurityPolicy', () => {
  it("enforces Trusted Types for 'script' and allows exactly the three policies C4 names", () => {
    const policy = reachContentSecurityPolicy('n0nce-n0nce-n0nce-n0nce-n0nce')
    expect(policy).toContain("require-trusted-types-for 'script'")
    expect(policy).toContain('trusted-types default delorun-plugin-loader delorun-blob-worker')
    // The directive list names the default policy, the client module loader's policy and the blob Worker policy, and
    // nothing else: a policy whose name this directive omits cannot be created at all.
    expect(/trusted-types ([^;]+)/.exec(policy)?.[1]).toBe('default delorun-plugin-loader delorun-blob-worker')
  })

  // The four capabilities that build a Worker from a Blob need worker-src to admit blob:, which is a separate
  // directive from Trusted Types: the constructor accepts the minted URL and the Worker is still refused without it.
  it("admits a blob: Worker source, and still never allows 'unsafe-eval'", () => {
    const policy = reachContentSecurityPolicy('n0nce-n0nce-n0nce-n0nce-n0nce')
    expect(/worker-src ([^;]+)/.exec(policy)?.[1]).toBe("'self' blob:")
    expect(policy).not.toContain('unsafe-eval')
  })
})
