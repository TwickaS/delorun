/** The webhook bundle's shared secret reaches no command a delivery's chat runs. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const patch = readFileSync(fileURLToPath(new URL('../../bundle-webhooks/cordis.patch.yml', import.meta.url)), 'utf8')
const SECRET = /secretEnv: (\S+)/u.exec(patch)![1]!
const port = /process\.env\.(DELORUN_GITHUB_WEBHOOK_PORT)/u.exec(patch)![1]!

const saved = { secret: process.env[SECRET], port: process.env[port] }
afterEach(() => {
  for (const [name, value] of [[SECRET, saved.secret], [port, saved.port]] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

describe('the webhook port', () => {
  const expression = /port: !!js "(.+)"/u.exec(patch)![1]!
  const portOf = (value: string | undefined): unknown => {
    if (value === undefined) Reflect.deleteProperty(process.env, port)
    else process.env[port] = value
    return new Function(`return ${expression}`)()
  }

  it('is 3081 unless set, and a whole port number when set', () => {
    expect(portOf(undefined)).toBe(3081)
    expect(portOf('18530')).toBe(18530)
  })

  it('fails loud at load for anything that is not a port number', () => {
    for (const bad of ['abc', '', '0', '70000', '3081.5', '-1', ' x ']) {
      expect(() => portOf(bad), bad).toThrow(/must be a whole number from 1 to 65535/u)
    }
  })
})

describe('the webhook secret', () => {
  it('is not in the environment a session command inherits, whatever the secret looks like', () => {
    for (const value of ['hunter2', 'a'.repeat(40), 'whsec_0123456789abcdef']) {
      process.env[SECRET] = value
      const child = scrubbedParentEnv()
      expect(Object.keys(child), value).not.toContain(SECRET)
      expect(Object.values(child), value).not.toContain(value)
    }
  })

  it('is named by the bundle as the credential reference the adapter reads', () => {
    expect(SECRET).toBe('DELORUN_GITHUB_WEBHOOK_SECRET')
    // The adapter reads the secret from this variable; the bundle's `delorun.requires` makes Plugins say "Needs setup" until it is set.
    expect(patch).toContain(`secretEnv: ${SECRET}`)
  })
})
