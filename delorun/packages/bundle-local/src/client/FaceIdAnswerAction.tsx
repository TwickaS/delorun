/**
 * The approval card's Face ID step for a request that asks for a grant (full access, workspace management, an external
 * agent or the real browser). On a paired phone whose home has the `unlock.passkeys` flag on, the card's allow answers
 * first open the action sheet of [`FaceIdSheet.tsx`](./FaceIdSheet.tsx); the home accepts the answer only with a grant
 * minted for exactly this Session, call, grants marker and the value `allowed-once`. A cancelled sheet sends nothing and
 * leaves the card answerable. Reject, requests that grant nothing, the home's own computer and a home with the flag off
 * never ask.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApprovalActionOwnerProps, ApprovalGrant } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { httpPasskeyApi } from './face-id-api.ts'
import { browserPasskeys, faceIdKindOf, type PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, PasskeyApi } from './face-id-types.ts'
import { FaceIdPin } from './FaceIdPin.tsx'
import { flagIsOn } from './FaceIdSection.tsx'
import { FaceIdSheet } from './FaceIdSheet.tsx'
import type { HostFetch } from './host-api.ts'
import type { PinSource } from './pin-lock.ts'

/** What the plugin supplies the action for one chat. */
export interface FaceIdAnswerInjected {
  /** The chat the card belongs to: the `agent` of the answer grant. */
  readonly sessionId: string
  /** Sends the action's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
  /** Whether the page is on the home's own computer. */
  readonly atComputer: () => boolean
  /** The lock's store, whose view tells whether a PIN is set and what kind. */
  readonly hooks: PinSource['hooks']
  /** The page's passkey calls; a spec supplies a fake. */
  readonly browser?: PasskeyBrowser
  /** The page's passkey routes; a spec supplies a fake. */
  readonly api?: PasskeyApi
}

/** Props the renderer binds for the action. */
export type FaceIdAnswerProps = ApprovalActionOwnerProps & PropsLocale<'delorunFaceId'> & InjectFace<FaceIdAnswerInjected>

/** The value the card's allow answers send. */
const ANSWER_VALUE = 'allowed-once'

type Step = 'sheet' | 'pin'

/**
 * The sheet's words and the grant request for one approval request.
 * @param t - the copy.
 * @param request - the request's Session id, call id, grants marker and tool.
 * @returns the action.
 */
export function answerActionOf(t: PropsLocale<'delorunFaceId'>['t'], request: { readonly sessionId: string; readonly callId: string; readonly grants: ApprovalGrant; readonly toolName: string | undefined }): FaceIdAction {
  return {
    title: t(`answer.${request.grants}.title`),
    body: t(`answer.${request.grants}.body`, { agent: request.toolName ?? '' }),
    grant: { answer: { agent: request.sessionId, callId: request.callId, grants: request.grants, value: ANSWER_VALUE } },
  }
}

/**
 * Render the step.
 * @param props - the card's request and gate, the chat, the page's passkey calls and the copy.
 * @returns the sheet or the PIN entry while the person confirms; otherwise nothing.
 */
export function FaceIdAnswerAction({ t, grants, callId, toolName, gateAllow, sessionId, fetch, atComputer, usePin, browser, api: injectedApi }: FaceIdAnswerProps): ReactNode {
  const [on, setOn] = useState(false)
  const [hasPasskey, setHasPasskey] = useState(false)
  const [step, setStep] = useState<Step | undefined>(undefined)
  const settle = useRef<((sent: boolean) => void) | null>(null)
  const api = useMemo(() => injectedApi ?? httpPasskeyApi(fetch), [injectedApi, fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const pin = usePin(view => view)
  const secret = pin.phase === 'off' || pin.phase === 'unknown' ? undefined : pin.secret
  const computer = atComputer()
  // A prompt without a call id cannot be keyed, so no grant covers it.
  const asks = grants !== undefined && callId !== undefined && !computer
  useEffect(() => {
    if (!asks) return
    let current = true
    void flagIsOn(fetch).then(async (flag) => {
      if (!flag || !current) return
      const state = await api.state().catch(() => undefined)
      if (!current) return
      setHasPasskey((state?.passkeys.length ?? 0) > 0)
      setOn(true)
    })
    return () => { current = false }
  }, [asks, fetch, api])
  const close = useCallback((sent: boolean): void => {
    setStep(undefined)
    const done = settle.current
    settle.current = null
    done?.(sent)
  }, [])
  useEffect(() => {
    if (!on) return
    gateAllow(() => new Promise<boolean>((resolve) => {
      settle.current = resolve
      setStep('sheet')
    }))
    return () => {
      gateAllow(null)
      const done = settle.current
      settle.current = null
      done?.(false)
    }
  }, [on, gateAllow])
  if (!on || step === undefined || grants === undefined || callId === undefined) return null
  const action = answerActionOf(t, { sessionId, callId, grants, toolName })
  const fallbackToPin = secret !== undefined
  if (step === 'pin' && secret !== undefined) {
    return <FaceIdPin t={t} action={action} api={api} secret={secret} onGranted={() => { close(true) }} onBack={() => { setStep('sheet') }} />
  }
  return <FaceIdSheet t={t} action={action} kind={kind} api={api} browser={passkeys} hasPasskey={hasPasskey} fallback={fallbackToPin ? 'pin' : 'computer'}
    onGranted={() => { close(true) }} onCancel={() => { close(false) }}
    onFallback={() => { if (fallbackToPin) setStep('pin'); else close(false) }} />
}
