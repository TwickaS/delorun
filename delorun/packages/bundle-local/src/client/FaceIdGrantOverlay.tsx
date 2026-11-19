/**
 * The `shell.overlay` entry that shows the Face ID confirmation for a call another plugin is about to send, such as a
 * Changes or update control. The calling plugin reaches it through `ctx.delorunFaceGrant`; the sheet and the PIN fallback
 * are those of the approval card's step.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FaceGrantRequest } from '@delorun/plugin-changes/face-grant'
import { httpPasskeyApi } from './face-id-api.ts'
import { browserPasskeys, faceIdKindOf, type PasskeyBrowser } from './face-id-browser.ts'
import { hashRequest } from './face-id-hash.ts'
import { CHANGE_CONTROLS } from './face-id-locales.ts'
import type { FaceIdAction, PasskeyApi } from './face-id-types.ts'
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
 * The sheet's words and grant for one call.
 * @param t - the copy.
 * @param request - the call and its action, `changes/<control>`.
 * @returns the action, with the grant hashed from the call.
 */
export async function callActionOf(t: PropsLocale<'delorunFaceId'>['t'], request: FaceGrantRequest): Promise<FaceIdAction> {
  const control = request.action.replace(/^changes\//, '')
  const known = CHANGE_CONTROLS.find(entry => entry === control)
  return {
    title: known === undefined ? t('change.generic.title') : t(`change.${known}.title`),
    body: known === undefined ? t('change.generic.body') : t(`change.${known}.body`),
    grant: { actions: [{ action: request.action, hash: await hashRequest(request.call) }] },
  }
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
