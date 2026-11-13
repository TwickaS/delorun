// The sign-in page of a reach address (contracts C4 and C5). It keeps this browser's device key, non-extractable, in
// IndexedDB on this origin, asks the home for approval while the person has opened a window at the home's computer,
// shows the match code the person types there, and signs a fresh challenge to create a session. It writes no HTML:
// every text goes through textContent, which the page's Trusted Types policy allows.

const DATABASE = 'delo-device'
const STORE = 'keys'
const KEY_NAME = 'device'
const MATCH_LABEL = 'delo-match-v1'
const SIGN_IN_LABEL = 'delo-signin-v1'
const POLL_MS = 2500

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

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
  const value = await response.json().catch(() => ({}))
  return { status: response.status, value }
}

function show(id, text) {
  const element = document.getElementById(id)
  if (element !== null) element.textContent = text
}

function section(name) {
  for (const element of document.querySelectorAll('[data-step]')) element.hidden = element.dataset.step !== name
}

async function signIn(pair, deviceId) {
  const challenge = await post('/auth/device/challenge', { deviceId })
  if (challenge.status !== 200) return challenge
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signInMessage(location.origin, challenge.value.challenge))
  return post('/auth/session', { deviceId, challenge: challenge.value.challenge, signature: toBase64Url(signature) })
}

async function requestApproval(pair, jwk, deviceId) {
  const label = document.getElementById('label').value.trim()
  const deviceNonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const platform = navigator.userAgent.slice(0, 64)
  const sent = await post('/auth/device/request', { v: 1, devicePublicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, deviceNonce, label, platform })
  if (sent.status !== 201) {
    show('error', sent.value.message ?? 'The home refused this request.')
    return
  }
  const code = await matchCodeOf({ homePublicKey: sent.value.homePublicKey, deviceId, homeNonce: sent.value.homeNonce, deviceNonce, address: location.origin })
  show('match-code', `${code.slice(0, 4)} ${code.slice(4)}`)
  section('code')
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    const response = await fetch(`/auth/device/request/${sent.value.requestId}`, { headers: { authorization: `Delo-Request ${sent.value.requestSecret}` } })
    const state = await response.json().catch(() => ({}))
    if (state.state === 'approved') break
    if (response.status !== 200 && response.status !== 429) {
      show('error', state.message ?? 'This request ended. Start again.')
      section('request')
      return
    }
    if (state.state !== undefined && state.state !== 'pending') {
      show('error', 'This request ended. Start again.')
      section('request')
      return
    }
  }
  await finish(pair, deviceId)
}

// Where the device lands once signed in: the `next` the sign-in route accepted, or the studio's page. The route
// redirects any other `next` away before this script loads; the origin check keeps a landing on this address regardless.
function landing() {
  const next = new URLSearchParams(location.search).get('next')
  if (next === null || !next.startsWith('/') || next.startsWith('//')) return '/'
  return new URL(next, location.origin).origin === location.origin ? next : '/'
}

async function finish(pair, deviceId) {
  const signed = await signIn(pair, deviceId)
  if (signed.status === 201) {
    location.replace(landing())
    return
  }
  show('error', signed.value.message ?? 'Signing in failed.')
  section('request')
}

async function main() {
  const pair = await storedKey()
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const deviceId = await deviceIdOf(jwk)
  const signed = await signIn(pair, deviceId)
  if (signed.status === 201) {
    location.replace(landing())
    return
  }
  section('request')
  document.getElementById('request-form').addEventListener('submit', (event) => {
    event.preventDefault()
    show('error', '')
    void requestApproval(pair, jwk, deviceId)
  })
}

if (typeof document !== 'undefined') void main()
