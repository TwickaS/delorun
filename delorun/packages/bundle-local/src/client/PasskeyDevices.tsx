/**
 * Settings → Devices, passkeys (B4): a card per device with its passkeys, "Add Face ID" where this device has none, and
 * Remove for a passkey or a device. At the computer the list loads and each removal is one tap. On a phone the list
 * starts with this device's own passkeys; "Show all devices" and each removal first open the action sheet, so they take
 * Face ID (L92), with the PIN keypad after a cancel.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@delorun/brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import { hashArgs } from './face-id-hash.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi, PasskeyDevice, PasskeyEntry } from './face-id-types.ts'
import { FaceIdPin } from './FaceIdPin.tsx'
import { FaceIdSheet } from './FaceIdSheet.tsx'
import css from './FaceId.module.css'

type Translate = PropsLocale<'delorunFaceId'>['t']

/** Props of the passkey list. */
export interface PasskeyDevicesProps {
  readonly t: Translate
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  /** The noun of this page's own platform unlock, which the sheet's button names. */
  readonly kind: FaceIdKind
  /** Whether the page is the home's own computer, where nothing needs a prompt. */
  readonly atComputer: boolean
  /** The home's secret for the fallback keypad, or undefined when none is set (the sheet then points at the computer). */
  readonly secret: 'pin' | 'passcode' | undefined
  /** Start "Add Face ID" for this page's device. */
  readonly onAdd: () => void
}

type Target =
  | { readonly kind: 'list' }
  | { readonly kind: 'passkey'; readonly credentialId: string; readonly deviceId: string | undefined; readonly label: string }
  | { readonly kind: 'device'; readonly deviceId: string; readonly label: string }

type Asked = { readonly target: Target; readonly action: FaceIdAction; readonly pin: boolean; readonly hasPasskey: boolean }

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
 * Build the sheet's action for a target: its words, and the hash the home will compare against the call.
 * @param t - the copy.
 * @param target - what is about to happen.
 * @returns the action.
 */
async function actionOf(t: Translate, target: Target): Promise<FaceIdAction> {
  if (target.kind === 'list') {
    return { title: t('list.title'), body: t('list.body'), grant: { actions: [{ action: 'auth/passkey/devices', hash: await hashArgs({}) }] } }
  }
  if (target.kind === 'passkey') {
    return {
      title: t('remove.passkeyTitle', { name: target.label }), body: t('remove.passkeyBody'),
      grant: { actions: [{ action: 'auth/passkey/remove', hash: await hashArgs({ credentialId: target.credentialId, deviceId: target.deviceId }) }] },
      ...(target.deviceId === undefined ? {} : { noPin: true as const }),
    }
  }
  return {
    title: t('remove.deviceTitle', { name: target.label }), body: t('remove.deviceBody'),
    grant: { actions: [{ action: 'auth/devices/remove', hash: await hashArgs({ v: 1, deviceId: target.deviceId }) }] }, noPin: true,
  }
}

/**
 * The list without what a removal took away.
 * @param devices - the devices shown.
 * @param target - the removed passkey or device.
 * @returns the remaining devices.
 */
function withoutRemoved(devices: readonly PasskeyDevice[] | undefined, target: Target): readonly PasskeyDevice[] | undefined {
  if (target.kind === 'list' || devices === undefined) return devices
  if (target.kind === 'device') return devices.filter(device => device.deviceId !== target.deviceId)
  return devices.map(device => (device.passkeys.some(entry => entry.credentialId === target.credentialId)
    ? { ...device, passkeys: device.passkeys.filter(entry => entry.credentialId !== target.credentialId) } : device))
}

/**
 * Render the list.
 * @param props - see {@link PasskeyDevicesProps}.
 * @returns the cards.
 */
export function PasskeyDevices({ t, api, browser, kind, atComputer, secret, onAdd }: PasskeyDevicesProps): ReactNode {
  const [devices, setDevices] = useState<readonly PasskeyDevice[] | undefined>(undefined)
  const [all, setAll] = useState(atComputer)
  const [failed, setFailed] = useState(false)
  const [asked, setAsked] = useState<Asked | undefined>(undefined)
  const load = useCallback(async (grantId?: string): Promise<void> => {
    try {
      if (atComputer || grantId !== undefined) setDevices(await api.devices({ grantId }))
      else {
        const own = await api.state()
        setDevices([{ deviceId: 'this', label: t('devices.thisDevice'), thisDevice: true, passkeys: own.passkeys }])
      }
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [api, atComputer, t])
  useEffect(() => { void load() }, [load])
  const run = useCallback(async (target: Target, grantId?: string): Promise<void> => {
    try {
      if (target.kind === 'list') {
        await load(grantId)
        setAll(true)
        return
      }
      if (target.kind === 'passkey') await api.removePasskey({ credentialId: target.credentialId, deviceId: target.deviceId, grantId })
      else await api.removeDevice({ deviceId: target.deviceId, grantId })
    } catch {
      setFailed(true)
      return
    }
    // The grant is spent by the removal, so a phone's list drops the removed rows instead of reading the list again.
    if (atComputer || !all) await load()
    else setDevices(current => withoutRemoved(current, target))
  }, [api, load, all, atComputer])
  const ask = async (target: Target): Promise<void> => {
    if (atComputer) { await run(target); return }
    // This device's passkeys are read as the sheet opens, so a read still on its way never shows a passkey device as
    // having nothing to confirm with; a failed read shows the way down, and the home checks the grant itself.
    const [action, hasPasskey] = await Promise.all([actionOf(t, target), api.state().then(state => state.passkeys.length > 0, (): boolean => false)])
    setAsked({ target, action, pin: false, hasPasskey })
  }
  const done = (grantId: string): void => {
    const target = asked?.target
    setAsked(undefined)
    if (target !== undefined) void run(target, grantId)
  }
  const fallbackToPin = secret !== undefined && asked?.action.noPin !== true
  return <div data-face-id-devices>
    {failed ? <p className={css.failed} role="alert">{t('devices.failed')}</p> : null}
    {devices === undefined ? null : <div className={css.devices}>
      {devices.map(device => <DeviceCard key={device.deviceId} t={t} kind={kind} device={device} canRemoveDevice={all && !device.thisDevice}
        onAdd={onAdd} onRemove={(target) => { void ask(target) }} />)}
    </div>}
    {all ? null : <Button variant="secondary" type="button" className={css.action} onClick={() => { void ask({ kind: 'list' }) }}>{t('devices.showAll')}</Button>}
    {asked === undefined ? null : asked.pin && secret !== undefined
      ? <FaceIdPin t={t} action={asked.action} api={api} secret={secret} onGranted={done} onBack={() => { setAsked({ ...asked, pin: false }) }}
        onCancel={() => { setAsked(undefined) }} />
      : <FaceIdSheet t={t} action={asked.action} kind={kind} api={api} browser={browser} hasPasskey={asked.hasPasskey} fallback={fallbackToPin ? 'pin' : 'computer'}
        onGranted={done} onCancel={() => { setAsked(undefined) }}
        onFallback={() => { setAsked({ ...asked, pin: true }) }} />}
  </div>
}

/** One device's card. */
function DeviceCard({ t, kind, device, canRemoveDevice, onAdd, onRemove }: {
  readonly t: Translate; readonly kind: FaceIdKind; readonly device: PasskeyDevice; readonly canRemoveDevice: boolean
  readonly onAdd: () => void; readonly onRemove: (target: Target) => void
}): ReactNode {
  return <section className={css.card} data-face-id-device={device.deviceId}>
    <h3 className={css.cardTitle}>
      <span>{device.label}</span>
      {device.thisDevice && device.label !== t('devices.thisDevice') ? <span className={css.tag}>{t('devices.thisDevice')}</span> : null}
    </h3>
    {device.passkeys.map(passkey => <PasskeyRow key={passkey.credentialId} t={t} passkey={passkey} kind={kind} owner={device.thisDevice ? undefined : device.label}
      onRemove={() => { onRemove({ kind: 'passkey', credentialId: passkey.credentialId, deviceId: device.thisDevice ? undefined : device.deviceId, label: device.label }) }} />)}
    {device.passkeys.length === 0 && device.thisDevice
      ? <Button variant="primary" type="button" className={css.action} onClick={onAdd}>{t('devices.add')}</Button> : null}
    {canRemoveDevice
      ? <Button variant="secondary" type="button" className={css.action} onClick={() => { onRemove({ kind: 'device', deviceId: device.deviceId, label: device.label }) }}>
        {t('devices.removeOther')}
      </Button> : null}
  </section>
}

/**
 * One passkey inside a device's card. Its button removes the passkey, never the device: on this device it names the
 * method ("Remove Face ID from this device"), or the passkey when the method is only "your device"; on another device's
 * card it names that device, since this page cannot tell which method that passkey uses.
 */
function PasskeyRow({ t, passkey, kind, owner, onRemove }: {
  readonly t: Translate; readonly passkey: PasskeyEntry; readonly kind: FaceIdKind; readonly owner: string | undefined; readonly onRemove: () => void
}): ReactNode {
  const label = owner !== undefined ? t('devices.removePasskeyOn', { name: owner })
    : kind === 'deviceLock' ? t('devices.removePasskeyLock')
      : t('devices.removePasskey', { method: t(`kind.${kind}`) })
  return <div className={css.passkey} data-face-id-passkey={passkey.credentialId}>
    <p className={css.meta}>{t('devices.added', { date: day(t, passkey.createdAt) })} · {t(passkey.synced ? 'devices.synced' : 'devices.deviceOnly')}</p>
    <p className={css.meta}>{passkey.lastUsedAt === null ? t('devices.neverUsed') : t('devices.lastUsed', { date: day(t, passkey.lastUsedAt) })}</p>
    <Button variant="secondary" type="button" className={css.action} onClick={onRemove}>{label}</Button>
  </div>
}
