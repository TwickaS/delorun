/**
 * Settings → Devices, passkeys (B4): a card per device with its passkeys, "Add Face ID" where a device has none, and
 * Remove for a passkey or a device. On a phone each removal first opens the action sheet, so it takes Face ID
 * (L92); at the computer it is one tap. Desktop shows the cards in two columns.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi, PasskeyDevice, PasskeyEntry } from './face-id-types.ts'
import { FaceIdSheet, type FaceIdFallback } from './FaceIdSheet.tsx'
import css from './FaceId.module.css'

type Translate = PropsLocale<'delorunFaceId'>['t']

/** Props of the passkey list. */
export interface PasskeyDevicesProps {
  readonly t: Translate
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  /** The noun of this page's own platform unlock, which the sheet's button names. */
  readonly kind: FaceIdKind
  /** Whether the page is the home's own computer, where removal needs no prompt. */
  readonly atComputer: boolean
  /** Where the sheet's small link leads. */
  readonly fallback: FaceIdFallback
  /** Whether this page's device holds a passkey, which a phone needs to remove anything. */
  readonly hasPasskey: boolean
  /** Start "Add Face ID" for this page's device. */
  readonly onAdd: () => void
  readonly onFallback: () => void
  /** A hash of the removal's canonical arguments. */
  readonly hashOf: (request: { readonly kind: 'passkey' | 'device'; readonly id: string }) => string
}

type Pending = { readonly kind: 'passkey' | 'device'; readonly id: string; readonly label: string }

/**
 * A date as the card shows it.
 * @param t - the copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the day and month.
 */
function day(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { day: 'numeric', month: 'short' }).format(new Date(at))
}

/**
 * Render the list.
 * @param props - see {@link PasskeyDevicesProps}.
 * @returns the cards.
 */
export function PasskeyDevices({ t, api, browser, kind, atComputer, fallback, hasPasskey, onAdd, onFallback, hashOf }: PasskeyDevicesProps): ReactNode {
  const [devices, setDevices] = useState<readonly PasskeyDevice[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<Pending | undefined>(undefined)
  const reload = useCallback(async (): Promise<void> => {
    try {
      setDevices(await api.list())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [api])
  useEffect(() => { void reload() }, [reload])
  const remove = useCallback(async (target: Pending, grantId?: string): Promise<void> => {
    try {
      if (target.kind === 'passkey') await api.removePasskey({ passkeyId: target.id, grantId })
      else await api.removeDevice({ deviceId: target.id, grantId })
    } catch {
      setFailed(true)
      return
    }
    setPending(undefined)
    await reload()
  }, [api, reload])
  // A phone confirms with Face ID first; the computer removes at once.
  const ask = (target: Pending): void => {
    if (atComputer) void remove(target)
    else setPending(target)
  }
  const action: FaceIdAction | undefined = pending === undefined ? undefined : {
    name: pending.kind === 'passkey' ? 'passkey.remove' : 'device.remove',
    title: t(pending.kind === 'passkey' ? 'remove.passkeyTitle' : 'remove.deviceTitle', { name: pending.label }),
    body: t(pending.kind === 'passkey' ? 'remove.passkeyBody' : 'remove.deviceBody'),
    bodyHash: hashOf({ kind: pending.kind, id: pending.id }),
  }
  return <div data-face-id-devices>
    {failed ? <p className={css.failed} role="alert">{t('devices.failed')}</p> : null}
    {devices === undefined ? null : <div className={css.devices}>
      {devices.map(device => <DeviceCard key={device.id} t={t} device={device} onAdd={onAdd} onRemove={ask} />)}
    </div>}
    {pending === undefined || action === undefined ? null
      : <FaceIdSheet t={t} action={action} kind={kind} api={api} browser={browser} hasPasskey={hasPasskey} fallback={fallback}
        onGranted={(grantId) => { void remove(pending, grantId) }} onCancel={() => { setPending(undefined) }} onFallback={onFallback} />}
  </div>
}

/** One device's card. */
function DeviceCard({ t, device, onAdd, onRemove }: {
  readonly t: Translate; readonly device: PasskeyDevice
  readonly onAdd: () => void; readonly onRemove: (target: Pending) => void
}): ReactNode {
  return <section className={css.card} data-face-id-device={device.id}>
    <h3 className={css.cardTitle}>
      <span>{device.label}</span>
      {device.thisDevice ? <span className={css.tag}>{t('devices.thisDevice')}</span> : null}
    </h3>
    {device.lastSeenAt === undefined ? null : <p className={css.meta}>{t('devices.lastSeen', { time: day(t, device.lastSeenAt) })}</p>}
    {device.passkeys.map(passkey => <PasskeyRow key={passkey.id} t={t} passkey={passkey} device={device} onRemove={onRemove} />)}
    {device.passkeys.length === 0 && device.thisDevice
      ? <Button variant="primary" type="button" className={css.action} onClick={onAdd}>{t('devices.add')}</Button> : null}
    <Button variant="outline" type="button" className={css.action} onClick={() => { onRemove({ kind: 'device', id: device.id, label: device.label }) }}>
      {t(device.thisDevice ? 'devices.removeDevice' : 'devices.removeOther')}
    </Button>
  </section>
}

/** One passkey inside a device's card. */
function PasskeyRow({ t, passkey, device, onRemove }: {
  readonly t: Translate; readonly passkey: PasskeyEntry; readonly device: PasskeyDevice; readonly onRemove: (target: Pending) => void
}): ReactNode {
  const method = t(`kind.${passkey.kind}`)
  return <div className={css.passkey} data-face-id-passkey={passkey.id}>
    <p className={css.meta}>{method}</p>
    <p className={css.meta}>{t('devices.added', { date: day(t, passkey.addedAt) })} · {t(passkey.synced ? 'devices.synced' : 'devices.deviceOnly')}</p>
    {passkey.usesToday > 0 ? <p className={css.meta}>{t('devices.usedToday', { count: String(passkey.usesToday) })}</p> : null}
    <Button variant="outline" type="button" className={css.action} onClick={() => { onRemove({ kind: 'passkey', id: passkey.id, label: device.label }) }}>
      {t('devices.removePasskey', { method })}
    </Button>
  </div>
}
