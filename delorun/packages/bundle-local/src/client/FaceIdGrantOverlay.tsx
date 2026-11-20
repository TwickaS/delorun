/**
 * The `shell.overlay` entry that shows the Face ID confirmation for a call about to be sent, or sent again after the home
 * refused it for want of a grant: a Changes or update control, any Remote method, or any plugin Fetch route. The calling plugin reaches it through `ctx.delorunFaceGrant`; the sheet and the PIN fallback
 * are those of the approval card's step.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FaceGrantRequest } from '@delorun/plugin-changes/face-grant'
import { httpPasskeyApi } from './face-id-api.ts'
import { browserPasskeys, faceIdKindOf, type PasskeyBrowser } from './face-id-browser.ts'
import { hashArgs, hashRequest } from './face-id-hash.ts'
import { ACTION_COPY, CHANGE_CONTROLS, faceCopyOf, type FaceActionCopy } from './face-id-locales.ts'
import { PASS_SETTING_ACTION } from './face-id-pass.ts'
import type { FaceIdAction, PasskeyApi } from './face-id-types.ts'
import { COPY_ICON, faceIconOf } from './face-id-icon-keys.ts'
import { STAYS_OF_CHANGE, STAYS_OF_COPY } from './face-id-stays.ts'
import { FaceIdGrantFlow } from './FaceIdGrantFlow.tsx'
import type { FaceGrantSource } from './face-grant.ts'
import type { HostFetch } from './host-api.ts'
import type { PinSource } from './pin-lock.ts'

/** What the plugin supplies the overlay. */
export interface FaceIdGrantOverlayInjected {
  /** Sends the overlay's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
  /** The lock's store and the pending confirmation. */
  readonly hooks: PinSource['hooks'] & FaceGrantSource['hooks']
  /** Ends the pending confirmation. */
  readonly settle: FaceGrantSource['settle']
  /** The page's passkey calls; a spec supplies a fake. */
  readonly browser?: PasskeyBrowser
  /** The page's passkey routes; a spec supplies a fake. */
  readonly api?: PasskeyApi
}

/** Props the renderer binds for the overlay. */
export type FaceIdGrantOverlayProps = PropsLocale<'delorunFaceId'> & InjectFace<FaceIdGrantOverlayInjected>

/**
 * The words, glyph and workspace of the action a grant covers: a Changes control's own, an action of {@link ACTION_COPY}, or the generic ones.
 * @param t - the copy.
 * @param request - the call and its action.
 * @returns the title, the body, the items a batch covers, the glyph, what stays afterwards and the workspace the call names.
 */
function wordsOf(t: PropsLocale<'delorunFaceId'>['t'], request: FaceGrantRequest): Pick<FaceIdAction, 'title' | 'body' | 'items' | 'icon' | 'context' | 'stays'> {
  if (request.action.startsWith('changes/')) {
    const known = CHANGE_CONTROLS.find(entry => entry === request.action.slice('changes/'.length))
    const icon = faceIconOf(request.action)
    if (known === undefined) return { title: t('change.generic.title'), body: t('change.generic.body'), icon }
    const stays = STAYS_OF_CHANGE[known]
    return { title: t(`change.${known}.title`), body: t(`change.${known}.body`), icon, ...stays === undefined ? {} : { stays: t(stays) } }
  }
  const body = 'args' in request.call ? request.call.args : 'answer' in request.call ? {} : jsonOf(request.call.body)
  let copy: FaceActionCopy = faceCopyOf(request.action)
  if (copy === 'fullAccessOn' && Reflect.get(body, 'on') === false) copy = 'fullAccessOff'
  // The same grant switches the chat it names, so the sheet says so.
  else if (copy === 'fullAccessOn' && typeof Reflect.get(body, 'chat') === 'string') copy = 'fullAccessOnChat'
  const values: Record<string, string> = {}
  const workspace: unknown = Reflect.get(body, 'workspace')
  if (typeof workspace === 'string') values.workspace = lastSegment(workspace)
  const name: unknown = Reflect.get(body, 'serverName')
  if (typeof name === 'string') values.name = `“${name}”`
  const names: unknown = Reflect.get(body, 'names')
  const items = Array.isArray(names) && names.every(item => typeof item === 'string') ? { items: names } : {}
  // The title names the folder; the Workspace row shows its whole path, so two workspaces with the same folder name differ.
  const context = typeof workspace === 'string' ? { context: { workspace } } : {}
  const stays = STAYS_OF_COPY[copy]
  return { title: t(`do.${copy}.title`, values), body: t(`do.${copy}.body`, values), icon: COPY_ICON[copy], ...stays === undefined ? {} : { stays: t(stays, values) }, ...context, ...items }
}

/**
 * @param body - a Fetch call's body.
 * @returns the JSON object it holds, or an empty object for any other body.
 */
function jsonOf(body: object | string): object {
  if (typeof body !== 'string') return body
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (_notJson) {
    // A body that is not JSON names nothing the words show.
    return {}
  }
}

/**
 * @param path - a folder path or a name.
 * @returns its last segment, which the sheet shows as the workspace's name.
 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts.at(-1) ?? path
}

/**
 * The sheet's words and grant for one call. The pass setting takes Face ID itself, so its sheet offers no PIN keypad.
 * @param t - the copy.
 * @param request - the call, its action and the hold it opens.
 * @returns the action, with the grant hashed from the call.
 */
export async function callActionOf(t: PropsLocale<'delorunFaceId'>['t'], request: FaceGrantRequest): Promise<FaceIdAction> {
  // An answer grant is bound to its prompt and value, which the home compares itself; it has no hash.
  if ('answer' in request.call) return { ...wordsOf(t, request), grant: { answer: request.call.answer } }
  const hash = 'args' in request.call ? await hashArgs(request.call.args) : await hashRequest(request.call)
  return { ...wordsOf(t, request), grant: { actions: [{ action: request.action, hash, ...request.hold === undefined ? {} : { hold: request.hold } }] }, ...request.action === PASS_SETTING_ACTION ? { noPin: true as const } : {} }
}

/**
 * Render the overlay.
 * @param props - the pending confirmation, the lock's view and the page's passkey calls.
 * @returns the sheet or the keypad while a confirmation waits; otherwise nothing.
 */
export function FaceIdGrantOverlay({ t, fetch, usePending, usePin, settle, browser, api: injectedApi }: FaceIdGrantOverlayProps): ReactNode {
  const pending = usePending(current => current)
  // The action is kept with the confirmation it was built for, so a new confirmation never shows the previous one's words.
  const [built, setBuilt] = useState<{ readonly id: number; readonly for: typeof pending; readonly action: FaceIdAction; readonly hasPasskey: boolean } | undefined>(undefined)
  const sequence = useRef(0)
  const api = useMemo(() => injectedApi ?? httpPasskeyApi(fetch), [injectedApi, fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const pin = usePin(view => view)
  const secret = pin.phase === 'off' || pin.phase === 'unknown' ? undefined : pin.secret
  useEffect(() => {
    if (pending === null) return
    let current = true
    // A failed read of the device's passkeys opens the PIN keypad, which the home checks itself.
    const held = api.state().then((state) => (state.passkeys.length > 0), (): boolean => false)
    void Promise.all([callActionOf(t, pending.request), held]).then(([next, hasPasskey]) => { if (current) setBuilt({ id: ++sequence.current, for: pending, action: next, hasPasskey }) })
    return () => { current = false }
  }, [pending, t, api])
  if (pending === null || built?.for !== pending) return null
  return <FaceIdGrantFlow key={built.id} t={t} action={built.action} kind={kind} api={api} browser={passkeys} hasPasskey={built.hasPasskey} secret={secret}
    onGranted={settle} onCancel={() => { settle(undefined) }} />
}
