/**
 * The Face ID settings section (B1, B4): it lists the passkeys, sets one up on a paired device with the code typed at the
 * computer, takes that code at the computer, and holds "Ask again after", the Face ID pass setting (A499), which a phone
 * shows once it has Face ID set up.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserPasskeys, faceIdKindOf, type PasskeyBrowser } from './face-id-browser.ts'
import { httpPasskeyApi } from './face-id-api.ts'
import { AddFaceId, PasskeyCodeEntry } from './FaceIdEnrol.tsx'
import { PasskeyDevices } from './PasskeyDevices.tsx'
import type { FaceGrant } from '@delorun/plugin-changes/face-grant'
import type { PassSource } from './face-id-pass.ts'
import { FacePassSetting } from './FacePassSetting.tsx'
import type { HostFetch } from './host-api.ts'
import type { PinSource } from './pin-lock.ts'
import css from './FaceId.module.css'

/** What the plugin supplies. */
export interface FaceIdSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
  /** Whether the page is on the home's own computer. */
  readonly atComputer: () => boolean
  /** The lock's store, whose view tells whether a PIN is set and what kind, and the page's pass mirror. */
  readonly hooks: PinSource['hooks'] & PassSource['hooks']
  /** The page's passkey calls; a spec supplies a fake. */
  readonly browser?: PasskeyBrowser
  /** The confirmation a phone's change of the pass setting takes. */
  readonly grant: FaceGrant
}

/** Props the renderer binds for the section. */
export type FaceIdSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunFaceId'> & InjectFace<FaceIdSectionInjected>

/**
 * Render the section.
 * @param props - see {@link FaceIdSectionProps}.
 * @returns the section.
 */
export function FaceIdSection({ t, fetch, atComputer, usePin, usePass, browser, grant }: FaceIdSectionProps): ReactNode {
  const [adding, setAdding] = useState(false)
  const [version, setVersion] = useState(0)
  const api = useMemo(() => httpPasskeyApi(fetch), [fetch])
  const passkeys = useMemo(() => browser ?? browserPasskeys(), [browser])
  const pin = usePin(view => view)
  const secret = pin.phase === 'off' || pin.phase === 'unknown' ? undefined : pin.secret
  const kind = useMemo(() => faceIdKindOf(globalThis.navigator), [])
  const computer = atComputer()
  const passState = usePass(state => state)
  const [hasPasskey, setHasPasskey] = useState(false)
  useEffect(() => {
    if (computer) return
    let current = true
    void api.state().then((state) => { if (current) setHasPasskey(state.passkeys.length > 0) }, () => undefined)
    return () => { current = false }
  }, [api, computer, version])
  return <div className={css.section}>
    <h2 className={css.sectionTitle}>{t('section.title')}</h2>
    <p className={css.body}>{t('section.intro')}</p>
    {computer ? <PasskeyCodeEntry t={t} api={api} onDone={() => { setVersion(count => count + 1) }} /> : null}
    {adding && !computer
      ? <AddFaceId t={t} kind={kind} api={api} browser={passkeys} onCancel={() => { setAdding(false) }}
        onDone={() => { setAdding(false); setVersion(count => count + 1) }} />
      : <PasskeyDevices key={version} t={t} api={api} browser={passkeys} kind={kind} atComputer={computer} secret={secret}
        onAdd={() => { setAdding(true) }} />}
    {computer || hasPasskey ? <FacePassSetting t={t} fetch={fetch} pass={passState} atComputer={computer} grant={grant} /> : null}
  </div>
}
