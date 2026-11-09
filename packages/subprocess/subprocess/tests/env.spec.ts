/**
 * The shared child-environment scrub: every ambient name and value shape a child never inherits implicitly, and the
 * ordinary entries that still survive so a child CLI runs normally.
 */
import { describe, expect, it } from 'vitest'
import { scrubbedParentEnv } from '../src/index.ts'

/**
 * The scrubbed child env after setting one ambient probe entry, with the probe restored afterwards.
 * @param entries - the ambient entries to set for the read.
 * @returns the scrubbed child environment.
 */
function childEnvWith(entries: Record<string, string>): Record<string, string> {
  const saved = new Map(Object.keys(entries).map(key => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(entries)) process.env[key] = value
    return scrubbedParentEnv()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

/**
 * The BEGIN or END line of a PEM private key block, assembled at run time so no key-shaped text is committed.
 * @param edge - which line.
 * @returns the line.
 */
function pemLine(edge: 'BEGIN' | 'END'): string {
  return ['-----', edge, ' RSA PRIVATE KEY', '-----'].join('')
}

describe('the denylisted ambient names', () => {
  // Each value is ordinary: the name alone must drop the entry, so a value-shape match cannot mask a missing rule.
  it.each([
    ['SSH_AUTH_SOCK', 'opaque'],
    ['DOCKER_HOST', 'opaque'],
    ['GOOGLE_APPLICATION_CREDENTIALS', 'opaque'],
    ['AWS_REGION', 'eu-central-1'],
    ['AZURE_TENANT_ID', 'opaque'],
    ['SLACK_CHANNEL_ID', 'opaque'],
    ['DISCORD_GUILD_ID', 'opaque'],
    ['DEPLOY_WEBHOOK_URL', 'opaque'],
    ['SERVICE_PASSWD', 'opaque'],
  ])('drops ambient %s', (name, value) => {
    expect(childEnvWith({ [name]: value })[name]).toBeUndefined()
  })

  it('matches a denylisted name case-insensitively, as Windows holds environment names', () => {
    expect(childEnvWith({ ssh_auth_sock: 'opaque' }).ssh_auth_sock).toBeUndefined()
    expect(childEnvWith({ aws_region: 'opaque' }).aws_region).toBeUndefined()
  })

  it('keeps an ordinary ambient name and the executable path', () => {
    const env = childEnvWith({ SCRUB_PROBE_PLAIN: 'visible' })
    expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
    expect(env.PATH).toBeDefined()
  })
})

describe('the credential-shaped values', () => {
  it('drops a name whose value is a URL with user information', () => {
    const env = childEnvWith({ SCRUB_PROBE_ENDPOINT: 'https://robot:canary@registry.example.invalid/v1' })
    expect(env.SCRUB_PROBE_ENDPOINT).toBeUndefined()
  })

  it('drops a name whose value is a webhook URL on a hooks host', () => {
    expect(childEnvWith({ SCRUB_PROBE_ENDPOINT: 'https://hooks.example.invalid/services/T000/B000/canary' }).SCRUB_PROBE_ENDPOINT).toBeUndefined()
  })

  it('drops a name whose value is a webhook URL on a /webhooks path', () => {
    expect(childEnvWith({ SCRUB_PROBE_ENDPOINT: 'https://chat.example.invalid/api/webhooks/123/canary' }).SCRUB_PROBE_ENDPOINT).toBeUndefined()
  })

  it('drops a name whose value is a PEM private key block', () => {
    const block = [pemLine('BEGIN'), 'MIIBcanarybody', pemLine('END')].join('\n')
    expect(childEnvWith({ SCRUB_PROBE_BODY: block }).SCRUB_PROBE_BODY).toBeUndefined()
  })

  it.each([
    ['an AWS credential file', '/opt/ci/.aws/credentials'],
    ['a netrc file', '~/.netrc'],
    ['an SSH private key', '/home/runner/.ssh/id_rsa'],
    ['a service-account key', '/opt/keys/service-account.json'],
  ])('drops a name whose value is the path of %s', (_form, value) => {
    expect(childEnvWith({ SCRUB_PROBE_FILE: value }).SCRUB_PROBE_FILE).toBeUndefined()
  })

  it.each([
    ['an SSH agent socket', '/tmp/ssh-canary/agent.4242'],
    ['a GnuPG agent socket', '/run/user/1000/gnupg/S.gpg-agent'],
    ['a keyring socket', '/run/user/1000/keyring/ssh'],
  ])('drops a name whose value is %s', (_form, value) => {
    expect(childEnvWith({ SCRUB_PROBE_SOCKET: value }).SCRUB_PROBE_SOCKET).toBeUndefined()
  })

  it('keeps an ordinary URL, a bare path and a locale', () => {
    const env = childEnvWith({
      SCRUB_PROBE_ENDPOINT: 'https://example.invalid/docs?page=2',
      SCRUB_PROBE_DIRECTORY: '/opt/ci/workspace',
      SCRUB_PROBE_LOCALE: 'en_US.UTF-8',
    })
    expect(env.SCRUB_PROBE_ENDPOINT).toBe('https://example.invalid/docs?page=2')
    expect(env.SCRUB_PROBE_DIRECTORY).toBe('/opt/ci/workspace')
    expect(env.SCRUB_PROBE_LOCALE).toBe('en_US.UTF-8')
  })
})
