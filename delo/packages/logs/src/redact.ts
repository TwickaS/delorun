/**
 * C20's redactor. Every record passes it before it is written: registered secret values and their encodings (step
 * 1), the values of secret-named object keys (step 2), listed secret forms (step 3), and an error's message, stack
 * and own properties (step 4). It runs before truncation, so it never sees a secret cut in half.
 *
 * @module @delo/logs/redact
 */
import { MIN_REGISTERED_SECRET_LENGTH, REDACTED_KEY_PARTS, REDACTION_EXEMPT_FIELDS, type SecretKind } from '@delo/contract-operational-logs'

/** The kind a step-3 pattern names in its `[redacted:<kind>]` marker. */
export type PatternKind =
  | 'authorization'
  | 'cookie'
  | 'bearer'
  | 'basic'
  | 'url-userinfo'
  | 'url-parameter'
  | 'webhook-url'
  | 'credential-file-path'
  | 'private-key'
  | 'provider-key'
  | 'github-token'
  | 'aws-key-id'
  | 'jwt'
  | 'slack-token'
  | 'owner-code'
  | 'env-secret'

/** The value that replaces a secret-named key's value (step 2). */
export const REDACTED_VALUE = '[redacted]'

/**
 * The marker that replaces a secret in text.
 * @param kind - the registered value's kind or the matched pattern's.
 * @returns `[redacted:<kind>]`.
 */
export function redactionMarker(kind: SecretKind | PatternKind): string {
  return `[redacted:${kind}]`
}

/** An error after step 4, in the fields of C20's `err`. */
export interface RedactedError {
  /** The error's name. */
  readonly name: string
  /** The error's `code`, when it is a string or a number. */
  readonly code?: string
  /** The redacted message; for a thrown value that is not an `Error`, its redacted JSON. */
  readonly message: string
  /** The redacted stack. */
  readonly stack?: string
}

interface Pattern {
  readonly regex: RegExp
  readonly replace: (match: string, ...groups: string[]) => string
}

/** Values already replaced by an earlier step, which a later pattern leaves alone. */
const NOT_A_MARKER = String.raw`(?!["']?\[redacted)`

/**
 * How long a run of path characters a pattern reads, and how long a name may be on either side of the word that marks
 * it. A filesystem path, an environment variable name and a query parameter name are all far shorter than these. Each
 * bound is what keeps a pattern's work per position of the text fixed: a record holding a megabyte of `/word/word` or
 * 64 KiB of one letter — a model can print either — costs time linear in its length, not quadratic in it. An unbounded
 * `*` before an alternation over the same characters backtracks once per character for every position that starts a
 * match, which is the shape that made a 10 MiB record take minutes.
 */
const PATH_MAX_CHARS = 256
const NAME_MAX_CHARS = 64

/** How long a URL a webhook pattern reads; a real endpoint is shorter, and the bound keeps the scan linear. */
const URL_MAX_CHARS = 4096

/** A URL scheme as a URL's text begins: a letter, then up to 31 scheme characters, then `://`. */
const URL_START = String.raw`\b[a-z][a-z0-9+.-]{0,31}:\/\/`

/** What precedes a path in text: the start of the text, or a space, a quote, a backtick, `=` or `(`. */
const PATH_LEAD = String.raw`(^|[\s"'\u0060=(])`

/**
 * Whether a base32 run is an owner code rather than ordinary prose. The contract's code is 26 base32 characters,
 * which a person may paste in either case and in groups. A run of letters only in lower case is a word — English
 * prose reaches 26 letters without much trouble — whereas a code carries a digit with probability
 * 1 − (26/32)^26 ≈ 0.995, so a digit, an upper-case letter or a group separator marks the run as a code. A run
 * separated by spaces or hyphens counts only when its groups are even: every group but the last has one width,
 * because a code is pasted in blocks of one size while the words of a sentence are not. `task-runner finished 3
 * steps in` is 26 base32 characters with a digit, and the even-group rule is what keeps it out.
 * @param match - the run the pattern matched, separators included.
 * @returns whether it is a code.
 */
function isOwnerCode(match: string): boolean {
  const groups = match.split(/[- ]/)
  if (groups.length > 1) {
    const [width] = groups.map(group => group.length)
    const even = width !== undefined && width >= 2 && groups.slice(0, -1).every(group => group.length === width)
    return even && /[2-7]/.test(match)
  }
  return /[2-7]/.test(match) || /[A-Z]/.test(match)
}

/**
 * The last segment of a path, which is where a credential file's own name is.
 * @param path - a path token.
 * @returns the text after its last separator.
 */
function lastSegment(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** A credential file named in one segment, where a login looks for it; a copy or a public half is the same file. */
const CREDENTIAL_FILE_NAME = /(?:\.netrc|\.npmrc|\.pgpass|\.git-credentials|application_default_credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519))[^/\\]*$/i
/** The credential files whose name is two segments: `.aws/credentials` and `.docker/config.json`. */
const CREDENTIAL_FILE_PAIR = /(?:\.aws[/\\]credentials|\.docker[/\\]config\.json)[^/\\]*$/i
/** A service-account key file: the last segment carries `service[-_]?account` and ends in `.json`. */
const SERVICE_ACCOUNT_FILE = /service[_-]?account[^/\\]*\.json/i

/**
 * Whether a bounded path token names a file that holds credentials. The token is decided as a whole rather than by a
 * pattern that scans back over it: a pattern needs an unbounded `[^/\\\s"']*` before `service` to find the name in its
 * last segment, and that scan repeats for every position of the token, which is the quadratic shape this file avoids.
 * A path followed by a sentence's full stop is still a path, so the caller strips the stop before asking.
 * @param path - a run of path characters.
 * @returns whether it names a credential file.
 */
function isCredentialPath(path: string): boolean {
  return CREDENTIAL_FILE_PAIR.test(path) || CREDENTIAL_FILE_NAME.test(path) || SERVICE_ACCOUNT_FILE.test(lastSegment(path))
}

/** A webhook host, as Slack and its kin name one. */
const WEBHOOK_HOST = new RegExp(String.raw`^${URL_START}hooks\.`, 'i')
/** A webhook path: `/webhook`, `/webhooks`, `.webhook` or `.webhooks` between separators. */
const WEBHOOK_PATH = /[/.]webhooks?[/.]/i

/**
 * Whether a URL carries a secret of its own: a `hooks.` host, or a `/webhook(s)` path that authorises the post.
 * Deciding this from the whole URL token keeps the scan linear — a pattern with an unanchored `[^\s"'<>]*` before
 * `[/.]webhooks?[/.]` re-reads the rest of a whitespace-free run for every `://` in it.
 * @param url - a bounded URL token.
 * @returns whether it is a webhook endpoint.
 */
function isWebhookUrl(url: string): boolean {
  return WEBHOOK_HOST.test(url) || WEBHOOK_PATH.test(url)
}

/** The step-3 forms, in the order they apply. Each regex is global, so `String.replace` replaces every match. */
const PATTERNS: readonly Pattern[] = [
  // A PEM private key block; an unterminated block is redacted to the end of the text.
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => redactionMarker('private-key'),
  },
  // A key body whose BEGIN line is not in the record, as a truncated capture or a pasted body leaves it: two or more
  // 64-character base64 lines. One such line alone stays, because a single line is not evidence of a key and a
  // capture may well hold one.
  {
    regex: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{64}(?:\r?\n[A-Za-z0-9+/]{64})+(?:\r?\n[A-Za-z0-9+/]{1,63})?(?:\r?\n-----END [A-Z0-9 ]*PRIVATE KEY-----)?/g,
    replace: () => redactionMarker('private-key'),
  },
  // The value of an Authorization, Proxy-Authorization, Cookie or Set-Cookie header, as a header line or a JSON field.
  {
    regex: new RegExp(String.raw`\b(proxy-authorization|authorization|set-cookie|cookie)(["']?\s*[:=]\s*)${NOT_A_MARKER}("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)`, 'gi'), // us-spelling: quoted output
    replace: (_match, name = '', separator = '', value = '') => {
      const marker = redactionMarker(name.toLowerCase().endsWith('cookie') ? 'cookie' : 'authorization')
      const quote = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : ''
      return `${name}${separator}${quote}${marker}${quote}`
    },
  },
  {
    regex: new RegExp(String.raw`\b(Bearer|bearer|Basic)(\s+)${NOT_A_MARKER}[A-Za-z0-9._~+/-]{8,}=*`, 'g'),
    replace: (_match, scheme = '', space = '') => `${scheme}${space}${redactionMarker(scheme === 'Basic' ? 'basic' : 'bearer')}`,
  },
  // The user information of a URL. The scheme is bounded, so a line of `a-b-a-b` — every `a` a word start — cannot
  // make the scan quadratic.
  {
    regex: new RegExp(String.raw`(${URL_START})[^\s/?#@]+@`, 'gi'),
    replace: (_match, scheme = '') => `${scheme}${redactionMarker('url-userinfo')}@`,
  },
  // A URL query parameter whose name contains token, key, secret, password, code or sig. The name is bounded on each
  // side of the marking word: two unbounded `[^=&;#\s]*` around it re-read the rest of a long name once per position.
  {
    regex: new RegExp(String.raw`([?&;])([^=&;#\s]{0,${NAME_MAX_CHARS}}?(?:token|key|secret|password|code|sig)[^=&;#\s]{0,${NAME_MAX_CHARS}})=${NOT_A_MARKER}[^&;#\s"'<>]+`, 'gi'),
    replace: (_match, separator = '', name = '') => `${separator}${name}=${redactionMarker('url-parameter')}`,
  },
  // A webhook endpoint — a `hooks.` host or a `/webhook(s)` path — whose path is the secret that authorises the post.
  // The URL is read as one bounded token and decided as a whole, which keeps the scan linear: an unanchored
  // `[^\s"'<>]*` before `[/.]webhooks?[/.]` re-reads the rest of a whitespace-free run for every `://` in it.
  {
    regex: new RegExp(String.raw`${URL_START}[^\s"'<>]{1,${URL_MAX_CHARS}}`, 'gi'),
    replace: match => isWebhookUrl(match) ? redactionMarker('webhook-url') : match,
  },
  // The path of a file that holds credentials, whatever precedes it. The path is read as one bounded token and
  // decided as a whole, because no literal anchors the last form — `service[-_]?account…json` is a name, not a lead —
  // and a pattern that reached it with `[^/\\\s"']*service` backtracked once per character for every path start.
  {
    regex: new RegExp(String.raw`${PATH_LEAD}([~A-Za-z0-9._/\\-]{1,${PATH_MAX_CHARS}})`, 'gi'),
    replace: (match, lead = '', path = '') => {
      // A path a sentence ends after keeps its full stop: the token is greedy, so the stop belongs to the sentence.
      const stop = /\.+$/.exec(path)?.[0] ?? ''
      const token = path.slice(0, path.length - stop.length)
      return isCredentialPath(token) ? `${lead}${redactionMarker('credential-file-path')}${stop}` : match
    },
  },
  { regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, replace: () => redactionMarker('provider-key') },
  { regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: () => redactionMarker('github-token') },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => redactionMarker('aws-key-id') },
  { regex: /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, replace: () => redactionMarker('jwt') },
  { regex: /\bxox[a-z]-[A-Za-z0-9-]{8,}/g, replace: () => redactionMarker('slack-token') },
  // An owner code in any spelling the person may paste: the contract's 26 base32 characters, compact or in groups
  // separated by a space or a hyphen, in either case.
  {
    regex: /(?<![A-Za-z0-9])[A-Za-z2-7](?:[- ]?[A-Za-z2-7]){25}(?![A-Za-z0-9])/g,
    replace: match => isOwnerCode(match) ? redactionMarker('owner-code') : match,
  },
  // A NAME=value pair whose name contains KEY, TOKEN, SECRET, PASSWORD or COOKIE. The name is bounded on each side of
  // the marking word: `[A-Za-z0-9_]*KEY[A-Za-z0-9_]*` re-reads the rest of a long name once per position, so a line of
  // `KEYKEYKEY…` cost its own length squared.
  {
    regex: new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]{0,${NAME_MAX_CHARS}}?(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Za-z0-9_]{0,${NAME_MAX_CHARS}})=${NOT_A_MARKER}("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&;]+)`, 'gi'),
    replace: (_match, name = '') => `${name}=${redactionMarker('env-secret')}`,
  },
]

/**
 * The text forms in which a registered value is replaced: the value, its whole base64 and base64url encodings, the
 * part of each that is the same at each of the three byte alignments the value can take inside a longer encoding, its hexadecimal, its URL encoding with `%20` and
 * with `+` for spaces, and its JSON string escape. Matching ignores case, which covers upper-case hexadecimal and
 * percent escapes.
 */
function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  const forms = new Set<string>([
    value, bytes.toString('hex'), encodeURIComponent(value), encodeURIComponent(value).replaceAll('%20', '+'), JSON.stringify(value).slice(1, -1),
    bytes.toString('base64'), bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url'),
  ])
  for (let offset = 0; offset < 3; offset += 1) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes])
    // Characters fully determined by the value's bits: those after the offset bytes and before the trailing partial group.
    const first = Math.ceil((offset * 8) / 6)
    const last = Math.floor(((offset + bytes.length) * 8) / 6)
    for (const encoding of ['base64', 'base64url'] as const) {
      const core = shifted.toString(encoding).slice(first, last)
      if (core.length >= MIN_REGISTERED_SECRET_LENGTH) forms.add(core)
    }
  }
  return [...forms].filter(form => form.length > 0)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

function isSecretKey(key: string): boolean {
  if ((REDACTION_EXEMPT_FIELDS as readonly string[]).includes(key)) return false
  const lower = key.toLowerCase()
  return REDACTED_KEY_PARTS.some(part => lower.includes(part))
}

/**
 * The redactor of one process. A process registers every secret value it holds or reads when it loads it, and every
 * record it writes passes {@link Redactor.text}; structured values pass {@link Redactor.fields} first and errors
 * {@link Redactor.error}.
 */
export class Redactor {
  /** Each registered value with its kind and how many registrations hold it. */
  private readonly registered = new Map<string, { kind: SecretKind; holders: number }>()
  /** Each encoded form, lower-cased, with the kind it redacts to; rebuilt when a registration changes. */
  private forms = new Map<string, SecretKind>()
  private matcher: RegExp | undefined

  /**
   * Register a secret value, so each occurrence of it and of its encodings in a record is replaced with
   * `[redacted:<kind>]`. A value shorter than C20's minimum of 8 characters is not registered, because replacing it
   * would hit ordinary text; the listed patterns still apply to it.
   * @param value - the secret value, as the process holds it.
   * @param kind - what the value is.
   * @returns a disposer that unregisters this registration; the value stays registered while another holds it.
   */
  register(value: string, kind: SecretKind): () => void {
    if (value.length < MIN_REGISTERED_SECRET_LENGTH) return () => {}
    const entry = this.registered.get(value)
    if (entry === undefined) this.registered.set(value, { kind, holders: 1 })
    else entry.holders += 1
    this.rebuild()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.registered.get(value)
      /* v8 ignore next -- a live disposer's value is registered until its own call removes it */
      if (current === undefined) return
      current.holders -= 1
      if (current.holders === 0) this.registered.delete(value)
      this.rebuild()
    }
  }

  /**
   * Steps 1 and 3 over text: registered values and their encodings, then the listed secret forms.
   * @param text - a message, a captured line, an error's message or stack.
   * @returns the text with each secret replaced by its marker.
   */
  text(text: string): string {
    let result = text
    if (this.matcher !== undefined) {
      const forms = this.forms
      // The matcher holds exactly the lower-cased keys of `forms` and matches without case, so every match has a kind.
      result = result.replace(this.matcher, match => redactionMarker(forms.get(match.toLowerCase())!))
    }
    for (const pattern of PATTERNS) result = result.replace(pattern.regex, pattern.replace)
    return result
  }

  /**
   * Step 2 over a structured value: a JSON-ready copy in which the value of every object key whose name contains
   * `key`, `token`, `secret`, `password`, `passwd`, `cookie`, `credential`, `authorization` or `session` is
   * `[redacted]`, except C20's id fields. An error inside becomes its {@link Redactor.error} fields, a repeated
   * reference `[circular]`, binary data `[binary <n> bytes]`, a value with `toJSON` its JSON value, and functions
   * and symbols are left out. Strings are
   * not changed; the caller passes the serialised text through {@link Redactor.text}.
   * @param value - the value to copy.
   * @returns the copy.
   */
  fields(value: unknown): unknown {
    return this.copyFields(value, new Set())
  }

  /**
   * Step 4: an error's name, code, message and stack, the last two through steps 1 and 3. Its other own properties
   * are not written. A thrown value that is not an `Error` becomes a `NonError` whose message is its redacted JSON.
   * @param error - the thrown value.
   * @returns the fields of C20's `err`.
   */
  error(error: unknown): RedactedError {
    if (!(error instanceof Error)) {
      return { name: 'NonError', message: this.text(safeJson(this.fields(error))) }
    }
    const code: unknown = (error as { code?: unknown }).code
    return {
      name: this.text(error.name),
      ...typeof code === 'string' || typeof code === 'number' ? { code: this.text(String(code)) } : {},
      message: this.text(error.message),
      ...error.stack === undefined ? {} : { stack: this.text(error.stack) },
    }
  }

  private rebuild(): void {
    const forms = new Map<string, SecretKind>()
    for (const [value, { kind }] of this.registered) {
      for (const form of encodedForms(value)) {
        const key = form.toLowerCase()
        if (!forms.has(key)) forms.set(key, kind)
      }
    }
    this.forms = forms
    // Longest first, so a value is replaced whole before a shorter form inside it can match.
    const alternatives = [...forms.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
    this.matcher = alternatives.length === 0 ? undefined : new RegExp(alternatives.join('|'), 'gi')
  }

  private copyFields(value: unknown, seen: Set<object>): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object') return undefined
    if (seen.has(value)) return '[circular]'
    if (value instanceof Error) return this.error(value)
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[binary ${String(value.byteLength)} bytes]`
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') return this.copyFields(toJSON.call(value), seen)
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map(item => this.copyFields(item, seen) ?? null)
      const entries: [string, unknown][] = value instanceof Map
        ? [...value].map(([key, item]) => [String(key), item])
        : value instanceof Set ? [...value].map((item, index) => [String(index), item]) : Object.entries(value)
      const copy: Record<string, unknown> = {}
      for (const [key, item] of entries) {
        const copied = isSecretKey(key) ? REDACTED_VALUE : this.copyFields(item, seen)
        if (copied !== undefined) copy[key] = copied
      }
      return copy
    } finally {
      seen.delete(value)
    }
  }
}

/**
 * JSON text of a value from {@link Redactor.fields}, which is always serialisable; `undefined` becomes `null`.
 * @param value - a copied value.
 * @returns its JSON.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}
