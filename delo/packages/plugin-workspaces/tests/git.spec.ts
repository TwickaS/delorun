/**
 * The pure parts of the clone's git hygiene: the options, the environment,
 * the token and URL checks, the credential helper's invocation, and the
 * redaction. No git process runs here; clone.spec.ts runs git.
 */
import { describe, expect, it } from 'vitest'
import { cloneEnvironment, cloneUrlProblem, GIT_ENV, GIT_OPTIONS, httpsRemote, redactClone, tokenGit, tokenProblem } from '../src/git.ts'

/** A token the checks accept. It is a fake value. */
const TOKEN = 'fixture-token-for-git-specs'

/** A clone URL with a port and a path, which the token applies to. */
const CLONE_URL = 'https://127.0.0.1:8443/owner/repo.git'

describe('GIT_OPTIONS', () => {
  it('clears the askpass program, turns hooks and the file monitor off, and allows only https', () => {
    expect(GIT_OPTIONS).toEqual([
      '-c', 'core.askPass=',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
    ])
  })
})

describe('GIT_ENV', () => {
  it('removes the names a clone must not inherit and turns the prompts off', () => {
    for (const name of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSL_CAINFO', 'GIT_TRACE2_EVENT', 'GIT_CURL_VERBOSE']) {
      expect(Object.hasOwn(GIT_ENV, name), name).toBe(true)
      expect(GIT_ENV[name], name).toBeUndefined()
    }
    expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0')
    expect(GIT_ENV.GCM_INTERACTIVE).toBe('never')
  })

  it('sets GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL, so no clone reads the system or the person\'s global configuration', () => {
    expect(GIT_ENV.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(GIT_ENV.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })
})

describe('cloneEnvironment', () => {
  it('removes the GIT_CONFIG, GIT_TRACE and GIT_ASKPASS names the parent sets, whatever their suffix', () => {
    const env = cloneEnvironment({
      PATH: '/usr/bin', HOME: '/home/a', GIT_CONFIG_KEY_0: 'core.pager', GIT_TRACE2_EVENT: '/tmp/trace', GIT_ASKPASS: '/bin/ask', git_config_count: '1',
    })
    for (const name of ['GIT_CONFIG_KEY_0', 'GIT_TRACE2_EVENT', 'GIT_ASKPASS', 'git_config_count']) {
      expect(Object.hasOwn(env, name), name).toBe(true)
      expect(env[name], name).toBeUndefined()
    }
    expect(Object.hasOwn(env, 'PATH')).toBe(false)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('removes the fixed names in any letter case, as Windows environment names are case-insensitive', () => {
    const env = cloneEnvironment({ git_dir: '/elsewhere' })
    expect(Object.hasOwn(env, 'git_dir')).toBe(true)
    expect(env.git_dir).toBeUndefined()
  })

  it('keeps GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL at the values a clone sets, whatever the parent sets', () => {
    const env = cloneEnvironment({ GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_GLOBAL: '/home/a/.gitconfig' })
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })

  it.each([
    ['transport and template', ['GIT_ALLOW_PROTOCOL', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR']],
    ['remote shell and proxy command', ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND']],
    ['client certificate', ['GIT_SSL_CERT', 'GIT_SSL_KEY']],
    ['proxy, in upper and lower case', ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']],
  ])('removes the %s names a parent environment sets', (_label, names) => {
    const env = cloneEnvironment(Object.fromEntries(names.map((name) => [name, 'set-by-parent'])))
    for (const name of names) {
      expect(Object.hasOwn(env, name), name).toBe(true)
      expect(env[name], name).toBeUndefined()
    }
  })
})

describe('tokenGit', () => {
  it('gives the helper the token with the URL host and path, and keeps the token out of the options', () => {
    const invocation = tokenGit(CLONE_URL, TOKEN)
    expect(invocation.options.join(' ')).not.toContain(TOKEN)
    expect(invocation.env).toMatchObject({ DELO_GIT_TOKEN: TOKEN, DELO_GIT_HOST: '127.0.0.1:8443', DELO_GIT_PATH: 'owner/repo.git' })
  })

  it('starts from the fixed options, resets the credential helpers before installing its own, and verifies TLS', () => {
    const { options } = tokenGit(CLONE_URL, TOKEN)
    expect(options.slice(0, GIT_OPTIONS.length)).toEqual([...GIT_OPTIONS])
    const reset = options.indexOf('credential.helper=')
    const helper = options.findIndex((option) => option.startsWith('credential.helper=!f() {'))
    expect(reset).toBeGreaterThan(-1)
    expect(helper).toBeGreaterThan(reset)
    expect(options).toEqual(expect.arrayContaining(['http.sslVerify=true', 'credential.useHttpPath=true']))
  })

  it.each([
    `https://user:delo-test-password-not-a-secret@127.0.0.1:8443/owner/repo.git`,
    'https://user@127.0.0.1:8443/owner/repo.git',
    'http://127.0.0.1:8443/owner/repo.git',
    'ssh://git@127.0.0.1:8443/owner/repo.git',
    'file:///srv/repo.git',
    'https://127.0.0.1:8443/owner/repo.git?ref=main',
    'https://127.0.0.1:8443/owner/repo.git#main',
    'https://127.0.0.1:8443/owner/repo\\git',
    'https://127.0.0.1:8443/owner/repo git',
    'https://',
  ])('refuses a URL that is not a bare https clone URL, with a TypeError that names no part of it', (url) => {
    expect(() => tokenGit(url, TOKEN)).toThrow(TypeError)
    expect(() => tokenGit(url, TOKEN)).toThrow('the repository URL must be an https URL without a user name, password, query or fragment')
  })

  it.each([
    ['empty', ''],
    ['made of two words', 'two words'],
    ['made of two lines', 'line one\nline two'],
    ['longer than 4096 characters', 'x'.repeat(4097)],
    ['not ASCII', 'café-token'],
  ])('refuses a token that is %s', (_label, token) => {
    expect(() => tokenGit(CLONE_URL, token)).toThrow(TypeError)
    expect(() => tokenGit(CLONE_URL, token)).toThrow('the token must be one line of at most 4096 printable ASCII characters without whitespace')
  })

  it('accepts a token of exactly 4096 printable characters', () => {
    expect(() => tokenGit(CLONE_URL, 'x'.repeat(4096))).not.toThrow()
  })
})

describe('cloneUrlProblem and tokenProblem', () => {
  it('accepts a bare https URL with a host', () => {
    expect(cloneUrlProblem(CLONE_URL)).toBeUndefined()
  })

  it('gives a reason for a URL with credentials that names no part of the URL', () => {
    const reason = cloneUrlProblem(`https://user:delo-test-password-not-a-secret@127.0.0.1:8443/owner/repo.git`)
    expect(reason).toBe('the repository URL must be an https URL without a user name, password, query or fragment')
  })

  it('accepts one line of printable characters without whitespace', () => {
    expect(tokenProblem(TOKEN)).toBeUndefined()
    expect(tokenProblem('x'.repeat(4096))).toBeUndefined()
    expect(tokenProblem('x'.repeat(4097))).toBe('the token must be one line of at most 4096 printable ASCII characters without whitespace')
  })
})

describe('redactClone', () => {
  it('replaces every occurrence of a secret with a placeholder', () => {
    expect(redactClone(`first ${TOKEN} then ${TOKEN}`, [TOKEN])).toBe('first [redacted] then [redacted]')
  })

  it('applies each secret in turn and ignores an empty one', () => {
    expect(redactClone('a-secret-b', ['secret', 'a-secret'])).toBe('a-[redacted]-b')
    expect(redactClone('unchanged text', ['', 'zz'])).toBe('unchanged text')
  })

  it('redacts the user name and password of a URL, and the value of a credential-helper line, whatever the secrets', () => {
    expect(redactClone('https://user:secret-value@host/a and https://secret-only@host/b', [])).toBe('https://[redacted]@host/a and https://[redacted]@host/b')
    expect(redactClone('username=x-access-token\npassword=secret-value\npassword=\n', [])).toBe('username=[redacted]\npassword=[redacted]\npassword=\n')
  })

  it('redacts the value of an Authorization header under the Basic, Bearer and token schemes', () => {
    expect(redactClone('Authorization: Basic c2VjcmV0\nauthorization: Bearer secret-value\nAuthorization: token secret-value', []))
      .toBe('Authorization: Basic [redacted]\nauthorization: Bearer [redacted]\nAuthorization: token [redacted]')
  })
})

describe('httpsRemote', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo.git'],
    ['ssh://git@github.com:22/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['ssh:///owner/repo.git', undefined],
    ['/srv/repo.git', undefined],
    ['file:///srv/repo.git', undefined],
  ])('maps the remote %s to %s', (remote, expected) => {
    expect(httpsRemote(remote)).toBe(expected)
  })
})
