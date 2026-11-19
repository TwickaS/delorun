/**
 * The pairing step as a full-screen overlay (B1): a phone the computer just approved holds a single-use enrolment ticket,
 * and its first studio page offers "Set up Face ID" once, ahead of the studio. Skipping hides it for this page; Settings →
 * Face ID offers it again. Nothing shows at the computer, while the flag is off, or when no ticket waits.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { browserPasskeys, faceIdKindOf } from './face-id-browser.ts'
import { httpPasskeyApi } from './face-id-api.ts'
import { FaceIdPairingStep } from './FaceIdEnrol.tsx'
import { flagIsOn, type FaceIdSectionInjected } from './FaceIdSection.tsx'
import css from './FaceId.module.css'

/** What the plugin supplies: the section's own supplies, without the lock's store. */
export type FaceIdPairingOverlayInjected = Pick<FaceIdSectionInjected, 'fetch' | 'atComputer' | 'browser'>

/** Props the renderer binds for the overlay. */
export type FaceIdPairingOverlayProps = PropsLocale<'delorunFaceId'> & InjectFace<FaceIdPairingOverlayInjected>

/**
 * Render the overlay.
 * @param props - see {@link FaceIdPairingOverlayProps}.
 * @returns the pairing step over the studio, or nothing.
 */
export function FaceIdPairingOverlay({ t, fetch, atComputer, browser }: FaceIdPairingOverlayProps): ReactNode {
  const [shown, setShown] = useState(false)
  const api = useMemo(() => httpPasskeyApi(fetch), [fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const computer = atComputer()
  useEffect(() => {
    if (computer) return undefined
    let current = true
    void flagIsOn(fetch).then(on => (on ? api.state() : undefined)).then(
      (state) => { if (current && state?.ticket === true) setShown(true) },
      () => undefined,
    )
    return () => { current = false }
  }, [computer, fetch, api])
  if (!shown) return null
  return <div className={css.cover} data-face-id-pairing>
    <FaceIdPairingStep t={t} kind={kind} api={api} browser={passkeys} onDone={() => { setShown(false) }} onSkip={() => { setShown(false) }} />
  </div>
}
