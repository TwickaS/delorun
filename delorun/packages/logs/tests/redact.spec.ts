/**
 * C20's redactor: registered values and their encodings, secret-named keys, the listed forms, and errors.
 */
import { describe, expect, it } from 'vitest'
import { Redactor } from '../src/index.ts'
import { canary, encodings, patternCanaries, patternLines, patternSecrets, pemLine } from './support.ts'

describe('step 1: registered values', () => {
  it('replaces a registered value and its base64, base64url, hexadecimal and URL-encoded forms with its kind', () => {
    const redactor = new Redactor()
    const value = `${canary('model-key')}/+ ?`
    redactor.register(value, 'model-key')
    for (const form of encodings(value)) {
      const text = redactor.text(`before ${form} after`)
      expect(text, form).toBe('before [redacted:model-key] after')
    }
  })

  it('replaces the value inside a longer base64 text at every byte alignment', () => {
    const redactor = new Redactor()
    const value = canary('start-token')
    redactor.register(value, 'start-token')
    for (const prefix of ['', 'a', 'ab', 'abc']) {
      const encoded = Buffer.from(`${prefix}${value}tail`).toString('base64')
      expect(redactor.text(encoded), prefix).not.toContain(Buffer.from(value).toString('base64').slice(4, -4))
      expect(redactor.text(encoded)).toContain('[redacted:start-token]')
    }
  })

  it('ignores a value shorter than 8 characters and keeps a value while another registration holds it', () => {
    const redactor = new Redactor()
    redactor.register('short', 'cookie')
    expect(redactor.text('a short word')).toBe('a short word')
    const value = canary('cookie')
    const first = redactor.register(value, 'cookie')
    const second = redactor.register(value, 'cookie')
    first()
    first()
    expect(redactor.text(value)).toBe('[redacted:cookie]')
    second()
    expect(redactor.text(value)).toBe(value)
  })
})

describe('step 2: secret-named keys', () => {
  it('replaces the value of each key whose name contains a listed part, in any case, except the id fields', () => {
    const redactor = new Redactor()
    const copy = redactor.fields({
      apiKey: 'a', TOKEN: 'b', clientSecret: 'c', password: 'd', passwd: 'e', setCookie: 'f', credentials: { nested: 'g' },
      Authorization: 'h', session: 'i', sessionId: 'kept-session', startId: 'kept-start', workspaceId: 'kept-workspace', plain: 'kept',
      list: [{ token: 'j' }],
    })
    expect(copy).toEqual({
      apiKey: '[redacted]', TOKEN: '[redacted]', clientSecret: '[redacted]', password: '[redacted]', passwd: '[redacted]', setCookie: '[redacted]',
      credentials: '[redacted]', Authorization: '[redacted]', session: '[redacted]', sessionId: 'kept-session', startId: 'kept-start',
      workspaceId: 'kept-workspace', plain: 'kept', list: [{ token: '[redacted]' }],
    })
  })

  it('copies maps, sets, binary data, cycles, errors and values with toJSON without throwing', () => {
    const redactor = new Redactor()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    const copy = redactor.fields({
      map: new Map([['secretValue', 'x'], ['other', 'y']]),
      set: new Set(['a']),
      bytes: new Uint8Array(3),
      cyclic,
      when: new Date(0),
      url: new URL('https://example.invalid/a'),
      big: 10n,
      fn: () => 1,
      failure: new Error('boom'),
    })
    expect(copy).toMatchObject({
      map: { secretValue: '[redacted]', other: 'y' },
      set: { 0: 'a' },
      bytes: '[binary 3 bytes]',
      cyclic: { name: 'loop', self: '[circular]' },
      when: '1970-01-01T00:00:00.000Z',
      url: 'https://example.invalid/a',
      big: '10',
      failure: { name: 'Error', message: 'boom' },
    })
    expect(copy).not.toHaveProperty('fn')
  })
})

describe('step 3: listed forms', () => {
  it('replaces every listed form in captured text', () => {
    const redactor = new Redactor()
    const canaries = patternCanaries()
    const text = redactor.text(patternLines(canaries).join('\n'))
    for (const secret of patternSecrets(canaries)) expect(text, secret).not.toContain(secret)
    for (const kind of ['provider-key', 'github-token', 'aws-key-id', 'jwt', 'slack-token', 'owner-code', 'authorization', 'cookie', 'url-userinfo', 'url-parameter', 'webhook-url', 'credential-file-path', 'env-secret', 'private-key']) {
      expect(text, kind).toContain(`[redacted:${kind}]`)
    }
    expect(text).toContain('fetch https://[redacted:url-userinfo]@git.example.invalid/repo.git failed')
    expect(text).toContain('?page=2&access_token=[redacted:url-parameter]#top')
  })

  it('redacts a header in a JSON field and a Bearer credential in prose', () => {
    const redactor = new Redactor()
    const token = patternCanaries().bearer
    expect(redactor.text(`{"authorization":"Bearer ${token}","accept":"*/*"}`)).toBe('{"authorization":"[redacted:authorization]","accept":"*/*"}')
    expect(redactor.text(`sent bearer ${token} upstream`)).toBe('sent bearer [redacted:bearer] upstream')
  })

  it('redacts an unterminated PEM block to the end of the text', () => {
    const redactor = new Redactor()
    const body = patternCanaries().pemBody
    expect(redactor.text(`key: ${pemLine('BEGIN')}\n${body.join('\n')}`)).toBe('key: [redacted:private-key]')
  })

  it('redacts a key body whose BEGIN line the record does not hold', () => {
    const redactor = new Redactor()
    const body = patternCanaries().pemBody
    // No line holds a run the owner-code form would read as a code.
    for (const line of body) expect(line).not.toMatch(/[A-Za-z2-7]{16}/)
    // The body swallows the line after it, as a body's last, short line is part of the block.
    expect(redactor.text(`pasted:\n${body.join('\n')}\ndone`)).toBe('pasted:\n[redacted:private-key]')
    // One 64-character line is not evidence of a key: a capture may hold one without a body to go with it.
    expect(redactor.text(body[0]!)).toBe(body[0])
  })

  it('redacts an owner code in either case and in groups, and leaves a lower-case word alone', () => {
    const redactor = new Redactor()
    const code = 'GEZDGNBVGY3TQOJQGEZDGNBVGY'
    const grouped = code.match(/.{1,4}/g)!.join('-')
    const unevenTail = `${code.slice(0, 20).match(/.{4}/g)!.join('-')}-${code.slice(20)}`
    for (const spelling of [code, code.toLowerCase(), grouped, unevenTail, `${code.slice(0, 13)} ${code.slice(13)}`]) {
      expect(redactor.text(`approve ${spelling} now`), spelling).toBe('approve [redacted:owner-code] now')
    }
    // A run of 26 lower-case letters with no digit is a word, not a code.
    expect(redactor.text('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz')
    // So is a sentence whose words happen to spell 26 base32 characters and carry a digit.
    expect(redactor.text('task-runner finished 3 steps in')).toBe('task-runner finished 3 steps in')
  })

  it('redacts a webhook URL on a hooks host and on a /webhooks path', () => {
    const redactor = new Redactor()
    const path = patternCanaries().webhookPath
    expect(redactor.text(`posted to https://hooks.example.invalid/services/T000/B000/${path}`)).toBe('posted to [redacted:webhook-url]')
    expect(redactor.text(`posted to https://chat.example.invalid/api/webhooks/${path}`)).toBe('posted to [redacted:webhook-url]')
    expect(redactor.text(`posted to https://ci.example.invalid/webhook/${path}?run=7`)).toBe('posted to [redacted:webhook-url]')
  })

  it('redacts the path of a credentials file in a field, a quoted value and prose', () => {
    const redactor = new Redactor()
    const path = patternCanaries().credentialPath
    expect(redactor.text(`GOOGLE_APPLICATION_CREDENTIALS=${path}`)).toBe('GOOGLE_APPLICATION_CREDENTIALS=[redacted:credential-file-path]')
    expect(redactor.text('token file "~/.netrc" absent')).toBe('token file "[redacted:credential-file-path]" absent')
    expect(redactor.text('signing with /home/runner/.ssh/id_rsa.')).toBe('signing with [redacted:credential-file-path].')
    expect(redactor.text('key at /opt/keys/service-account.json')).toBe('key at [redacted:credential-file-path]')
  })

  it('leaves ordinary text alone', () => {
    const redactor = new Redactor()
    const text = 'task-runner finished 3 steps in 120 ms; see https://example.invalid/docs?page=2'
    expect(redactor.text(text)).toBe(text)
  })
})

describe('step 4: errors', () => {
  it('redacts the message and the stack and keeps the name and code', () => {
    const redactor = new Redactor()
    const value = canary('session-secret')
    redactor.register(value, 'session-secret')
    const error = Object.assign(new Error(`refused ${value}`), { code: 'E_REFUSED', token: value })
    const redacted = redactor.error(error)
    expect(redacted.name).toBe('Error')
    expect(redacted.code).toBe('E_REFUSED')
    expect(redacted.message).toBe('refused [redacted:session-secret]')
    expect(redacted.stack).toContain('refused [redacted:session-secret]')
    expect(JSON.stringify(redacted)).not.toContain(value)
  })

  it('turns a thrown value that is not an Error into its redacted JSON', () => {
    const redactor = new Redactor()
    expect(redactor.error({ password: 'x', reason: 'no' })).toEqual({ name: 'NonError', message: '{"password":"[redacted]","reason":"no"}' })
    expect(redactor.error(undefined)).toEqual({ name: 'NonError', message: 'null' })
  })
})

// A model prints what it prints: one 10 MiB record or a 65 KiB line is a capture, not an attack on the redactor, and
// every record passes it before it is written. A step-3 pattern whose work grows with the square of the line's length
// — an unbounded `*` before an alternation over the same characters, or a scan to the end of a run for every position
// that starts a match — turns such a record into a denial of service: the shapes below took 490 s, 410 s and 13 s.
// The bounds are generous on purpose, so a loaded host passes and a regression fails.
describe('performance: step 3 stays linear in the length of the text', { timeout: 60_000 }, () => {
  /**
   * The CPU milliseconds a redaction used. CPU time, not wall-clock time: a busy machine deschedules the worker, which
   * lengthens the wall clock without the redactor doing more work.
   */
  function elapsed(text: string): { readonly elapsed: number; readonly redacted: string } {
    const started = process.cpuUsage()
    const redacted = new Redactor().text(text)
    const used = process.cpuUsage(started)
    return { elapsed: (used.user + used.system) / 1000, redacted }
  }

  it('redacts 1 MiB of path-like text in under 250 ms', () => {
    const text = `${'/a/b/c'.repeat(Math.ceil((1024 * 1024) / 6))} /home/runner/.ssh/id_rsa`
    const { elapsed: ms, redacted } = elapsed(text)
    // The text is still redacted, not merely fast: the path at its end is a credential file.
    expect(redacted.endsWith('[redacted:credential-file-path]')).toBe(true)
    expect(ms).toBeLessThan(250)
  })

  it('redacts 10 MiB of /word/word lines in under 2 s', () => {
    const line = '/word'.repeat(10)
    const text = Array.from({ length: Math.ceil((10 * 1024 * 1024) / `${line}\n`.length) }, () => `${line}\n`).join('')
    const { elapsed: ms, redacted } = elapsed(text)
    // No form is listed in it, so nothing changes but the redactor's own time.
    expect(redacted.length).toBe(text.length)
    expect(ms).toBeLessThan(2_000)
  })

  // 250 ms leaves room for a loaded machine; the quadratic shape this guards costs seconds.
  it('redacts a 65,536-byte single line in under 250 ms', () => {
    // The writer's longest record and the capture's line limit, in the one-letter run `writer.spec.ts` writes.
    const text = 'r'.repeat(65_536)
    const { elapsed: ms, redacted } = elapsed(text)
    expect(redacted).toBe(text)
    expect(ms).toBeLessThan(250)
  })

  it('redacts a 65,536-byte line whose every third position starts a match in under 250 ms', () => {
    // `ab-` puts a word start every three characters, so the scheme, path and name patterns all start a match over and
    // over in one line: the shape that made an unbounded `[a-z][a-z0-9+.-]*` before `://` re-read the rest of the line
    // at each start. It is 65 KiB here and not 10 MiB because the pattern's cost per start is what this guards.
    const text = 'ab-'.repeat(Math.ceil(65_536 / 3)).slice(0, 65_536)
    const { elapsed: ms, redacted } = elapsed(text)
    expect(redacted).toBe(text)
    expect(ms).toBeLessThan(250)
  })

  it('redacts a 65,536-byte line of long names in under 250 ms', () => {
    // A query parameter's name and an environment variable's name are each read around the word that marks them, so a
    // run that gives the word a match at every position — `?keykeykey…`, `KEYKEYKEY…` — is the shape that made an
    // unbounded `[^=&;#\s]*` or `[A-Za-z0-9_]*` on each side re-read the rest of the run at every position.
    const text = `?${'key'.repeat(10_922)}${'KEY'.repeat(10_922)}`
    const { elapsed: ms, redacted } = elapsed(text)
    // Neither run is followed by `=`, so neither is a pair a pattern lists.
    expect(redacted).toBe(text)
    expect(ms).toBeLessThan(250)
  })
})
