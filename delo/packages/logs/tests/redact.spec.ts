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
    for (const kind of ['provider-key', 'github-token', 'aws-key-id', 'jwt', 'slack-token', 'owner-code', 'authorization', 'cookie', 'url-userinfo', 'url-parameter', 'env-secret', 'private-key']) {
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
