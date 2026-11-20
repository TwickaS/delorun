/**
 * The pairing step as a full-screen overlay (B1): a phone the computer just approved holds a single-use enrolment ticket,
 * and its first studio page offers "Set up Face ID" once, ahead of the studio. Skipping is remembered in this origin's
 * local storage, which belongs to the browser that holds the device's key, so a reload never offers the step again; from
 * then on Settings → Face ID offers it, and the sheet of a device with nothing to confirm with names that place. Nothing
 * shows at the computer or when no ticket waits.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { browserPasskeys, faceIdKindOf } from './face-id-browser.ts'
import { httpPasskeyApi } from './face-id-api.ts'
import { FaceIdPairingStep } from './FaceIdEnrol.tsx'
import type { FaceIdSectionInjected } from './FaceIdSection.tsx'
import css from './FaceId.module.css'

/** The local storage key that records, by device id, the device that skipped the pairing step on this browser. */
export const PAIRING_SKIP_STORAGE_KEY = 'delorun.faceId.pairingSkipped'

/**
 * Whether this device skipped the pairing step on this browser; a browser paired again as a new device is offered it.
 * @param deviceId - the device's id, from the home's passkey state.
 * @param storage - the browser's local storage, or undefined where none exists.
 * @returns true when this device's skip is recorded; false otherwise, or when storage cannot be read.
 */
export function pairingSkipped(deviceId: string, storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(PAIRING_SKIP_STORAGE_KEY) === deviceId
  } catch {
    // Storage blocked (for example a private window): the step is offered again on the next load.
    return false
  }
}

/**
 * Record that this device skipped the pairing step on this browser.
 * @param deviceId - the device's id, from the home's passkey state.
 * @param storage - the browser's local storage, or undefined where none exists.
 */
export function rememberPairingSkip(deviceId: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(PAIRING_SKIP_STORAGE_KEY, deviceId)
  } catch {
    // Storage blocked: the skip is not remembered and the step is offered again on the next load.
  }
}

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
  const [shown, setShown] = useState<string | undefined>(undefined)
  const api = useMemo(() => httpPasskeyApi(fetch), [fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const computer = atComputer()
  useEffect(() => {
    if (computer) return undefined
    let current = true
    void api.state().then(
      (state) => { if (current && state.ticket && !pairingSkipped(state.deviceId)) setShown(state.deviceId) },
      () => undefined,
    )
    return () => { current = false }
  }, [computer, api])
  if (shown === undefined) return null
  const deviceId = shown
  return <div className={css.cover} data-face-id-pairing>
    <FaceIdPairingStep t={t} kind={kind} api={api} browser={passkeys} onDone={() => { setShown(undefined) }}
      onSkip={() => { rememberPairingSkip(deviceId); setShown(undefined) }} />
  </div>
}
