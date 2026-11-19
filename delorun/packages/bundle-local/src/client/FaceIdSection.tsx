/**
 * The Face ID settings section (B1, B4): it lists the passkeys, sets one up on a paired device with the code typed at the
 * computer, and takes that code at the computer.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserPasskeys, faceIdKindOf, type PasskeyBrowser } from './face-id-browser.ts'
import { httpPasskeyApi } from './face-id-api.ts'
import { AddFaceId, PasskeyCodeEntry } from './FaceIdEnrol.tsx'
import { PasskeyDevices } from './PasskeyDevices.tsx'
import type { HostFetch } from './host-api.ts'
import type { PinSource } from './pin-lock.ts'
import css from './FaceId.module.css'

/** What the plugin supplies. */
export interface FaceIdSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
  /** Whether the page is on the home's own computer. */
  readonly atComputer: () => boolean
  /** The lock's store, whose view tells whether a PIN is set and what kind. */
  readonly hooks: PinSource['hooks']
  /** The page's passkey calls; a spec supplies a fake. */
  readonly browser?: PasskeyBrowser
}

/** Props the renderer binds for the section. */
export type FaceIdSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunFaceId'> & InjectFace<FaceIdSectionInjected>

/**
 * Render the section.
 * @param props - see {@link FaceIdSectionProps}.
 * @returns the section.
 */
export function FaceIdSection({ t, fetch, atComputer, usePin, browser }: FaceIdSectionProps): ReactNode {
  const [adding, setAdding] = useState(false)
  const [hasPasskey, setHasPasskey] = useState(false)
  const [version, setVersion] = useState(0)
  const api = useMemo(() => httpPasskeyApi(fetch), [fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const pin = usePin(view => view)
  const secret = pin.phase === 'off' || pin.phase === 'unknown' ? undefined : pin.secret
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const computer = atComputer()
  useEffect(() => {
    let current = true
    void api.state().then(
      (state) => { if (current) setHasPasskey(state.passkeys.length > 0) },
      () => { if (current) setHasPasskey(false) },
    )
    return () => { current = false }
  }, [api, version])
  return <div className={css.section}>
    <h2 className={css.sectionTitle}>{t('section.title')}</h2>
    <p className={css.body}>{t('section.intro')}</p>
    {computer ? <PasskeyCodeEntry t={t} api={api} onDone={() => { setVersion(count => count + 1) }} /> : null}
    {adding && !computer
      ? <AddFaceId t={t} kind={kind} api={api} browser={passkeys} onCancel={() => { setAdding(false) }}
        onDone={() => { setAdding(false); setVersion(count => count + 1) }} />
      : <PasskeyDevices key={version} t={t} api={api} browser={passkeys} kind={kind} atComputer={computer} secret={secret} hasPasskey={hasPasskey}
        onAdd={() => { setAdding(true) }} />}
  </div>
}
