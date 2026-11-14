// The sign-in page of a reach address (contracts C4 and C5). It keeps this browser's device key, non-extractable, in
// IndexedDB on this origin, asks the home for approval while the person has opened a window at the home's computer,
// shows the match code the person types there, and signs a fresh challenge to create a session. It writes no HTML:
// every text goes through text nodes and textContent, which the page's Trusted Types policy allows. All of its copy is
// in COPY, in English and Chinese, chosen from the browser's languages.

const DATABASE = 'delorun-device'
const STORE = 'keys'
const KEY_NAME = 'device'
const MATCH_LABEL = 'delorun-match-v1'
const SIGN_IN_LABEL = 'delorun-signin-v1'
/** How often the page reads its request's state; the home refuses reads less than 2 seconds apart. */
export const POLL_MS = 2500
/** A request's life when the home's answer gives no usable expiry: C5's 5 minutes. */
const REQUEST_LIFE_MS = 300_000
/** Where the studio opens after sign-in when the page names no other landing. */
const STUDIO_PATH = '/'

const encoder = new TextEncoder()

/** Bytes of a base64url text. */
export function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

/** Base64url text of bytes, without padding. */
export function toBase64Url(bytes) {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** The RFC 7638 thumbprint of a P-256 public JWK, which is the device id. */
export async function deviceIdOf(jwk, subtle = crypto.subtle) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return toBase64Url(await subtle.digest('SHA-256', encoder.encode(canonical)))
}

/** C5's match code: 8 digits from both public keys, both nonces and the address. */
export async function matchCodeOf({ homePublicKey, deviceId, homeNonce, deviceNonce, address }, subtle = crypto.subtle) {
  const digest = new DataView(await subtle.digest('SHA-256', concat([
    encoder.encode(MATCH_LABEL), new Uint8Array([0]), fromBase64Url(homePublicKey), fromBase64Url(deviceId),
    fromBase64Url(homeNonce), fromBase64Url(deviceNonce), encoder.encode(address),
  ])))
  return (digest.getBigUint64(0, false) % 100000000n).toString().padStart(8, '0')
}

/** The bytes a sign-in signature covers. */
export function signInMessage(address, challenge) {
  return concat([encoder.encode(SIGN_IN_LABEL), new Uint8Array([0]), encoder.encode(address), fromBase64Url(challenge)])
}

/**
 * Every text the page shows, by language. In a text, `code` marks a command and **text** a name on screen; `{name}`
 * is replaced by a value, never parsed as markup.
 */
export const COPY = {
  en: {
    'document.title': 'Sign in to Delorun',
    'checking.title': 'Checking this device',
    'checking.lead': 'This takes a moment.',
    'request.title': 'Add this device',
    'request.lead': 'Your computer approves each new device once. After that, this browser signs in by itself.',
    'request.step1': 'At your computer, run `delorun devices approve`, or open **Settings → Devices** and choose **Add a device**.',
    'request.step2': 'Name this device below and choose **Ask for approval**.',
    'request.step3': 'Type the code this page shows into your computer.',
    'request.label': 'Device name',
    'request.hint': 'Your computer lists this device by this name.',
    'request.nameMissing': 'Enter a name for this device.',
    'request.nameRefused': 'This name can’t be used. Remove any special characters and try again.',
    'request.submit': 'Ask for approval',
    'request.sending': 'Asking…',
    'request.defaultName': 'My device',
    'waiting.title': 'Type this code at your computer',
    'waiting.spoken': 'Code: {digits}',
    'waiting.status': 'Waiting for your computer',
    'waiting.help': 'Find **{label}** in `delorun devices approve` or in **Settings → Devices**, then type the code there.',
    'waiting.expiresMany': 'Expires in {minutes} minutes',
    'waiting.expiresOne': 'Expires in 1 minute',
    'waiting.reconnecting': 'Lost the connection to your computer. Trying again…',
    'approved.title': 'Approved',
    'approved.lead': 'Signing you in…',
    'returning.title': 'Signing you in',
    'returning.lead': 'This device is already approved. Opening your studio…',
    'declined.title': 'Request cancelled',
    'declined.lead': 'Your computer cancelled this request, or the code was typed wrong three times. Ask again for a new code.',
    'expired.title': 'This code expired',
    'expired.lead': 'A code lasts 5 minutes. Ask again for a new one; if approval has closed at your computer, open it there first.',
    'closed.title': 'Your computer isn’t ready yet',
    'closed.lead': 'Open approval at your computer first: run `delorun devices approve`, or choose **Add a device** in **Settings → Devices**. It stays open for 5 minutes.',
    'busy.title': 'Too many devices waiting',
    'busy.lead': 'Five devices are already waiting for approval. At your computer, cancel the ones you don’t recognise, then try again.',
    'rate-limited.title': 'Too many tries',
    'rate-limited.lead': 'Wait a minute, then try again.',
    'sessions.title': 'This device has too many sign-ins',
    'sessions.lead': 'A sign-in ends after 12 hours unused. To start fresh now, remove this device in **Settings → Devices** at your computer and approve it again.',
    'offline.title': 'Can’t reach your computer',
    'offline.lead': 'Check that this device is connected in the Tailscale app and that Delorun is running on your computer.',
    'unsupported.title': 'This browser can’t sign in',
    'unsupported.lead': 'Signing in keeps a private key in this browser. Open this page in a current Safari, Chrome, Edge or Firefox, not in a private window.',
    'failed.title': 'Something went wrong',
    'failed.lead': 'Your computer refused this step. Try again; if it keeps happening, restart Delorun on your computer.',
    'failed.detail': 'Error code: {code}',
    'action.tryAgain': 'Try again',
    'action.askAgain': 'Ask again',
    'action.restart': 'Start over',
    'guide': 'How remote access works',
    'guide.newTab': '(opens in a new tab)',
  },
  zh: {
    'document.title': '登录 Delorun',
    'checking.title': '正在检查这台设备',
    'checking.lead': '请稍候',
    'request.title': '添加这台设备',
    'request.lead': '每台新设备只需在你的电脑上批准一次。之后，这个浏览器会自动登录',
    'request.step1': '在电脑上运行 `delorun devices approve`，或打开 **设置 → 设备** 并选择 **添加设备**。',
    'request.step2': '在下方为这台设备命名，然后选择 **请求批准**。',
    'request.step3': '把本页显示的代码输入到电脑上。',
    'request.label': '设备名称',
    'request.hint': '电脑会以这个名称列出这台设备',
    'request.nameMissing': '请为这台设备输入名称',
    'request.nameRefused': '不能使用这个名称。请删除特殊字符后重试',
    'request.submit': '请求批准',
    'request.sending': '正在请求…',
    'request.defaultName': '我的设备',
    'waiting.title': '在电脑上输入这个代码',
    'waiting.spoken': '代码：{digits}',
    'waiting.status': '正在等待你的电脑',
    'waiting.help': '在 `delorun devices approve` 或 **设置 → 设备** 中找到 **{label}**，然后在那里输入代码。',
    'waiting.expiresMany': '{minutes} 分钟后过期',
    'waiting.expiresOne': '1 分钟后过期',
    'waiting.reconnecting': '与电脑的连接已断开，正在重试…',
    'approved.title': '已批准',
    'approved.lead': '正在登录…',
    'returning.title': '正在登录',
    'returning.lead': '这台设备已获批准，正在打开你的 studio…',
    'declined.title': '请求已取消',
    'declined.lead': '你的电脑取消了这个请求，或代码输错了三次。请重新请求以获取新代码',
    'expired.title': '代码已过期',
    'expired.lead': '代码有效期为 5 分钟。请重新请求新代码；如果电脑上的批准已关闭，请先在电脑上重新打开',
    'closed.title': '电脑还没有准备好',
    'closed.lead': '请先在电脑上打开批准：运行 `delorun devices approve`，或在 **设置 → 设备** 中选择 **添加设备**。批准会保持打开 5 分钟。',
    'busy.title': '等待批准的设备太多',
    'busy.lead': '已有五台设备在等待批准。请在电脑上取消你不认识的请求，然后重试',
    'rate-limited.title': '尝试次数太多',
    'rate-limited.lead': '请等一分钟后再试',
    'sessions.title': '这台设备的登录太多',
    'sessions.lead': '登录在 12 小时未使用后结束。要立即重新开始，请在电脑上的 **设置 → 设备** 中移除这台设备，然后重新批准',
    'offline.title': '无法连接到你的电脑',
    'offline.lead': '请确认这台设备已在 Tailscale 应用中连接，并且电脑上的 Delorun 正在运行',
    'unsupported.title': '这个浏览器无法登录',
    'unsupported.lead': '登录需要在浏览器中保存一个私钥。请在最新版 Safari、Chrome、Edge 或 Firefox 中打开本页，不要使用无痕窗口',
    'failed.title': '出了点问题',
    'failed.lead': '电脑拒绝了这一步。请重试；如果一直出现，请在电脑上重启 Delorun',
    'failed.detail': '错误代码：{code}',
    'action.tryAgain': '重试',
    'action.askAgain': '重新请求',
    'action.restart': '重新开始',
    'guide': '远程访问如何工作',
    'guide.newTab': '（在新标签页中打开）',
  },
}

/**
 * What each view shows besides its title and lead: the badge's icon and tone, whether the badge spins, the steps, the
 * form, the code panel, the primary action's label and whether "Start over" shows.
 */
export const VIEWS = {
  checking: { icon: 'loading', spin: true },
  request: { icon: 'shield', tone: 'accent', steps: true, form: true },
  waiting: { code: true, restart: true },
  approved: { icon: 'check', tone: 'accent' },
  returning: { icon: 'check', tone: 'accent' },
  declined: { icon: 'close', retry: 'action.askAgain', restart: true },
  expired: { icon: 'clock', retry: 'action.askAgain', restart: true },
  closed: { icon: 'info', retry: 'action.tryAgain', restart: true },
  busy: { icon: 'users', retry: 'action.tryAgain', restart: true },
  'rate-limited': { icon: 'clock', retry: 'action.tryAgain', restart: true },
  sessions: { icon: 'users', retry: 'action.tryAgain' },
  offline: { icon: 'globe', retry: 'action.tryAgain' },
  unsupported: { icon: 'warning' },
  failed: { icon: 'warning', retry: 'action.tryAgain', restart: true },
}

/** The view an approval request's refusal leads to, by its code; any other refusal is `failed`. */
const REQUEST_REFUSALS = {
  APPROVALS_CLOSED: 'closed',
  APPROVAL_PENDING_LIMIT: 'busy',
  APPROVAL_RATE_LIMITED: 'rate-limited',
}

/**
 * The language of the page: Chinese when the browser prefers Chinese to English, otherwise English.
 * @param languages - the browser's languages, most preferred first.
 * @returns `zh` or `en`.
 */
export function languageOf(languages) {
  for (const language of languages) {
    const primary = String(language).toLowerCase().split('-')[0]
    if (primary === 'zh' || primary === 'en') return primary
  }
  return 'en'
}

/**
 * A name for this device that the person may keep, from the platform its browser reports.
 * @param userAgent - the browser's user agent.
 * @param copy - the page's copy.
 * @returns the name.
 */
export function defaultLabelOf(userAgent, copy) {
  const zh = copy === COPY.zh
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? (zh ? 'Android 手机' : 'Android phone') : (zh ? 'Android 平板' : 'Android tablet')
  if (/CrOS/.test(userAgent)) return 'Chromebook'
  if (/Macintosh/.test(userAgent)) return 'Mac'
  if (/Windows/.test(userAgent)) return zh ? 'Windows 电脑' : 'Windows PC'
  return copy['request.defaultName']
}

/**
 * Where the device lands once signed in: the page's `next`, which the sign-in route accepts only as a plain path on this
 * address, or the studio's page. The checks here keep a landing on this origin whatever the route did.
 * @param search - the page's query, with its `?`.
 * @param origin - the page's origin.
 * @returns a same-origin path.
 */
export function landingOf(search, origin) {
  const next = new URLSearchParams(search).get('next')
  if (next === null || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return STUDIO_PATH
  return new URL(next, origin).origin === origin ? next : STUDIO_PATH
}

/**
 * Write a copy text into an element as text nodes, `code` and `strong` elements.
 * @param element - the element, whose children are replaced.
 * @param text - the text, with its markup.
 * @param values - the values of its `{name}` placeholders.
 */
export function fill(element, text, values = {}) {
  const document = element.ownerDocument
  const nodes = []
  for (const part of text.split(/(`[^`]*`|\*\*[^*]*\*\*)/)) {
    if (part === '') continue
    const substitute = inner => inner.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
    if (part.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = substitute(part.slice(1, -1))
      nodes.push(code)
    } else if (part.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = substitute(part.slice(2, -2))
      nodes.push(strong)
    } else {
      nodes.push(document.createTextNode(substitute(part)))
    }
  }
  element.replaceChildren(...nodes)
}

/** The page's elements and how a view is drawn into them. */
class Screen {
  constructor(document, copy) {
    this.document = document
    this.copy = copy
    const find = id => document.getElementById(id)
    this.main = document.querySelector('main[data-sign-in]')
    this.card = find('card')
    this.badge = find('badge')
    this.icon = find('badge-icon')
    this.title = find('title')
    this.lead = find('lead')
    this.steps = find('steps')
    this.codePanel = find('code-panel')
    this.codeFirst = find('code-first')
    this.codeSecond = find('code-second')
    this.codeSpoken = find('code-spoken')
    this.expiry = find('expiry')
    this.help = find('help')
    this.form = find('request-form')
    this.label = find('label')
    this.labelError = find('label-error')
    this.submit = find('submit')
    this.note = find('note')
    this.detail = find('detail')
    this.actions = find('actions')
    this.retry = find('retry')
    this.restart = find('restart')
    this.announcer = find('announce')
    this.view = undefined
  }

  /** Write every static text and the language, and show the address. */
  prepare(host, defaultLabel) {
    this.document.documentElement.lang = this.copy === COPY.zh ? 'zh-CN' : 'en'
    this.document.title = this.copy['document.title']
    for (const element of this.document.querySelectorAll('[data-copy]')) fill(element, this.copy[element.dataset.copy])
    this.document.getElementById('address').textContent = host
    this.label.value = defaultLabel
    this.restart.textContent = this.copy['action.restart']
  }

  /**
   * Show a view.
   * @param name - its name in VIEWS.
   * @param values - `label` and `code` for `waiting`, `code` for `failed`, `fieldError` for `request`.
   */
  show(name, values = {}) {
    const view = VIEWS[name]
    this.view = name
    this.main.dataset.view = name
    this.badge.hidden = view.icon === undefined
    if (view.icon !== undefined) {
      this.icon.setAttribute('href', `#icon-${view.icon}`)
      this.badge.dataset.tone = view.tone ?? 'neutral'
      this.badge.toggleAttribute('data-spin', view.spin === true)
    }
    const title = name === 'waiting' ? 'waiting.title' : `${name}.title`
    fill(this.title, this.copy[title])
    const lead = this.copy[`${name}.lead`]
    this.lead.hidden = lead === undefined
    if (lead !== undefined) fill(this.lead, lead)
    this.steps.hidden = view.steps !== true
    this.form.hidden = view.form !== true
    this.submit.disabled = false
    fill(this.submit, this.copy['request.submit'])
    this.showFieldError(values.fieldError)
    this.codePanel.hidden = view.code !== true
    this.help.hidden = view.code !== true
    if (view.code === true) {
      this.codeFirst.textContent = values.code.slice(0, 4)
      this.codeSecond.textContent = values.code.slice(4)
      this.codeSpoken.textContent = this.copy['waiting.spoken'].replace('{digits}', values.code.split('').join(' '))
      fill(this.help, this.copy['waiting.help'], { label: values.label })
    }
    this.setNote(undefined)
    this.detail.hidden = values.code === undefined || name !== 'failed'
    if (name === 'failed' && values.code !== undefined) fill(this.detail, this.copy['failed.detail'], { code: values.code })
    this.actions.hidden = view.retry === undefined && view.restart !== true
    this.retry.hidden = view.retry === undefined
    if (view.retry !== undefined) this.retry.textContent = this.copy[view.retry]
    this.restart.hidden = view.restart !== true
    this.card.classList.remove('entering')
    void this.card.offsetWidth
    this.card.classList.add('entering')
    const spoken = name === 'waiting' ? `${this.title.textContent} ${this.codeSpoken.textContent}` : [this.title.textContent, lead === undefined ? '' : this.lead.textContent].join(' ').trim()
    this.announce(spoken)
    // Focus that was lost, or sits on a control the new view hid or disabled, moves to the view's title, so a keyboard
    // or screen reader keeps its place; focus elsewhere, such as on the guide link, stays.
    const active = this.document.activeElement
    if (active === null || active === this.document.body || (this.card.contains(active) && (active.closest('[hidden]') !== null || active.disabled === true))) this.title.focus()
  }

  /** Show or clear the device name's error. */
  showFieldError(key) {
    this.labelError.hidden = key === undefined
    this.label.setAttribute('aria-invalid', key === undefined ? 'false' : 'true')
    this.label.setAttribute('aria-describedby', key === undefined ? 'label-hint' : 'label-hint label-error')
    if (key !== undefined) this.labelError.textContent = this.copy[key]
  }

  /** Show the remaining life of the code. */
  setExpiry(remainingMs) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
    this.expiry.textContent = minutes === 1 ? this.copy['waiting.expiresOne'] : this.copy['waiting.expiresMany'].replace('{minutes}', String(minutes))
  }

  /** Show or clear the note under the view, and announce it. */
  setNote(key) {
    const text = key === undefined ? '' : this.copy[key]
    if (this.note.textContent === text && this.note.hidden === (key === undefined)) return
    this.note.hidden = key === undefined
    this.note.textContent = text
    if (key !== undefined) this.announce(text)
  }

  /** Mark the form as sending. */
  sending() {
    this.submit.disabled = true
    fill(this.submit, this.copy['request.sending'])
  }

  announce(text) {
    this.announcer.textContent = text
  }
}

/**
 * Call the home.
 * @returns `{ offline: true }` when the request did not reach it, otherwise its status, its JSON value, its refusal
 *   code and its `Date`.
 */
async function call(env, method, path, body, headers = {}) {
  let response
  try {
    response = await env.fetch(path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin',
    })
  } catch {
    // A request that never reached the home: no connection, or the home is not running.
    return { offline: true }
  }
  const value = await response.json().catch(() => ({}))
  const code = typeof value?.error === 'string' ? value.error : undefined
  return { offline: false, status: response.status, value, code, date: response.headers.get('date') }
}

/**
 * Run the page: check this device, ask for approval when it is new, show the match code and sign in once approved.
 * @param env - the browser's facilities, which a test replaces: `document`, `host`, `origin`, `languages`,
 *   `userAgent`, `fetch`, `subtle`, `random(n)`, `keys()` (the device key pair), `sleep(ms)`, `now()`, `open(path)`,
 *   `landing` (the path {@link landingOf} chose) and `supported`.
 * @returns the screen, for a test to read.
 */
export async function start(env) {
  const copy = COPY[languageOf(env.languages)]
  const screen = new Screen(env.document, copy)
  screen.prepare(env.host, defaultLabelOf(env.userAgent, copy))
  if (!env.supported) {
    screen.show('unsupported')
    return screen
  }
  screen.show('checking')
  let pair
  let jwk
  let deviceId
  try {
    pair = await env.keys()
    jwk = await env.subtle.exportKey('jwk', pair.publicKey)
    deviceId = await deviceIdOf(jwk, env.subtle)
  } catch {
    // No key could be made or kept: a browser without IndexedDB storage for keys, such as some private windows.
    screen.show('unsupported')
    return screen
  }

  // Each run of the flow has a number; a run that a newer one replaced stops at its next step.
  let run = 0
  let retry = check

  async function signIn() {
    const challenge = await call(env, 'POST', '/auth/device/challenge', { deviceId })
    if (challenge.offline || challenge.status !== 200) return challenge
    const signature = await env.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signInMessage(env.origin, challenge.value.challenge))
    return call(env, 'POST', '/auth/session', { deviceId, challenge: challenge.value.challenge, signature: toBase64Url(signature) })
  }

  function failed(answer) {
    if (answer.offline) return screen.show('offline')
    if (answer.code === 'SESSION_LIMIT_REACHED') return screen.show('sessions')
    if (answer.status === 429) return screen.show('rate-limited')
    return screen.show('failed', { code: answer.code ?? `HTTP ${String(answer.status)}` })
  }

  async function check() {
    const mine = ++run
    retry = check
    screen.show('checking')
    const signed = await signIn()
    if (mine !== run) return
    if (!signed.offline && signed.status === 201) {
      screen.show('returning')
      env.open(env.landing)
      return
    }
    if (!signed.offline && signed.code === 'DEVICE_NOT_TRUSTED') {
      screen.show('request')
      return
    }
    failed(signed)
  }

  async function ask() {
    const label = screen.label.value.trim()
    if (label === '') {
      screen.show('request', { fieldError: 'request.nameMissing' })
      screen.label.focus()
      return
    }
    const mine = ++run
    retry = ask
    screen.showFieldError(undefined)
    screen.sending()
    const deviceNonce = toBase64Url(env.random(16))
    const platform = env.userAgent.slice(0, 64)
    const sent = await call(env, 'POST', '/auth/device/request', { v: 1, devicePublicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, deviceNonce, label, platform })
    if (mine !== run) return
    if (sent.offline || sent.status !== 201) {
      if (!sent.offline && sent.code === 'BAD_REQUEST') {
        screen.show('request', { fieldError: 'request.nameRefused' })
        screen.label.focus()
        return
      }
      const view = sent.offline ? undefined : REQUEST_REFUSALS[sent.code]
      if (view !== undefined) screen.show(view)
      else failed(sent)
      return
    }
    const accepted = sent.value
    const code = await matchCodeOf({ homePublicKey: accepted.homePublicKey, deviceId, homeNonce: accepted.homeNonce, deviceNonce, address: env.origin }, env.subtle)
    if (mine !== run) return
    // The request's life from the home's own clock, so a device whose clock is wrong still counts down correctly.
    const homeNow = Date.parse(sent.date ?? '')
    const life = Number.isFinite(homeNow) && Number.isFinite(accepted.expiresAt) ? Math.min(Math.max(accepted.expiresAt - homeNow, 0), 2 * REQUEST_LIFE_MS) : REQUEST_LIFE_MS
    const deadline = env.now() + life
    screen.show('waiting', { code, label })
    screen.setExpiry(life)
    await wait(mine, accepted, deadline)
  }

  async function wait(mine, accepted, deadline) {
    for (;;) {
      await env.sleep(POLL_MS)
      if (mine !== run) return
      const read = await call(env, 'GET', `/auth/device/request/${accepted.requestId}`, undefined, { authorization: `Delorun-Request ${accepted.requestSecret}` })
      if (mine !== run) return
      const remaining = deadline - env.now()
      if (read.offline) {
        if (remaining <= 0) return void screen.show('expired')
        screen.setNote('waiting.reconnecting')
        continue
      }
      screen.setNote(undefined)
      if (read.status === 429) continue
      if (read.status === 200 && read.value.state === 'approved') return finish(mine)
      if (read.status === 200 && read.value.state === 'cancelled') return void screen.show('declined')
      if ((read.status === 200 && read.value.state === 'expired') || read.code === 'APPROVAL_EXPIRED') return void screen.show('expired')
      if (read.status !== 200) return void failed(read)
      screen.setExpiry(remaining)
    }
  }

  async function finish(mine) {
    retry = check
    screen.show('approved')
    const signed = await signIn()
    if (mine !== run) return
    if (!signed.offline && signed.status === 201) {
      env.open(env.landing)
      return
    }
    failed(signed)
  }

  screen.form.addEventListener('submit', (event) => {
    event.preventDefault()
    void ask()
  })
  screen.label.addEventListener('input', () => { screen.showFieldError(undefined) })
  screen.retry.addEventListener('click', () => { void retry() })
  screen.restart.addEventListener('click', () => {
    run += 1
    retry = check
    screen.show('request')
  })
  await check()
  return screen
}

function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error) }
  })
}

async function storedKey() {
  const db = await openStore()
  const read = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY_NAME)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error) }
  })
  if (read !== undefined) return read
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(pair, KEY_NAME)
    request.onsuccess = () => { resolve(undefined) }
    request.onerror = () => { reject(request.error) }
  })
  return pair
}

/** The real browser's facilities for {@link start}. */
function browserEnvironment() {
  return {
    document,
    host: location.host,
    origin: location.origin,
    languages: navigator.languages?.length > 0 ? navigator.languages : [navigator.language],
    userAgent: navigator.userAgent,
    fetch: (path, init) => fetch(path, init),
    subtle: globalThis.crypto?.subtle,
    random: size => crypto.getRandomValues(new Uint8Array(size)),
    keys: storedKey,
    sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
    now: () => Date.now(),
    open: (path) => { location.replace(path) },
    landing: landingOf(location.search, location.origin),
    supported: globalThis.isSecureContext === true && globalThis.crypto?.subtle !== undefined && typeof indexedDB !== 'undefined',
  }
}

if (typeof document !== 'undefined' && document.querySelector('main[data-sign-in]') !== null) void start(browserEnvironment())
