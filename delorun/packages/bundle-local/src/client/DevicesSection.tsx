/**
 * The Devices settings section: the reach state, the approved devices with their removal, the approval of a new
 * device while the approval window is open, and unlock requests. At the home's own computer it lists the devices asking
 * to unlock, each approved by typing the code the device shows or declined, and the running unlocks, each with End. On a
 * device (told by the place store of [`./unlock.ts`](./unlock.ts)) it offers no unlock: each sensitive action asks for
 * Face ID or the PIN when taken, and the section says so. Every request goes to the home through the injected `fetch`;
 * the home refuses device management to a remote studio, and the section says so in place.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, CodeCells, Dialog } from '@delorun/brand'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  approveDevice, cancelPendingDevice, ELEVATION_POLL_MS, hostFailureOf, LOOPBACK_REQUIRED, openApprovalWindow,
  PENDING_POLL_MS, readDevices, readElevationsAtComputer, readPendingDevices, readReachStatus, removeDevice, revokeElevation,
  type ApprovalRequestId, type Device, type DeviceList, type ElevationId, type ElevationRequestId, type ElevationsAtComputer,
  type HostFetch, type PendingDevice, type PendingElevation, type ReachOptionStatus, type ReachStatus,
} from './devices-api.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OptInMutation } from './opt-in.ts'
import type { PairingSource } from './pairing-source.ts'
import type { PairingRowSettings } from './pairing-writer.ts'
import { PairingSettings, type PairingSettingsProps } from './PairingSettings.tsx'
import type { UnlockSource, UnlockView } from './unlock.ts'
import { failureSentence, type Loaded } from './host-api.ts'
import css from './DevicesSection.module.css'

/** The command that turns remote access on, which the section shows while it is off. */
export const REACH_ON_COMMAND = 'delorun reach on tailscale'

/** What the section names in a refusal that needs the home's own computer. */
export type DevicesAction = 'status' | 'list' | 'add' | 'approve' | 'cancel' | 'remove' | 'unlocks' | 'unlockRevoke'


/** The request function and the place store the plugin supplies. */
export interface DevicesSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  hooks: Pick<UnlockSource['hooks'], 'unlock'> & {
    /** The requests that arrived without an approval window and the home's pairing choices. */
    pairing: PairingSource['hooks']['pairing']
    /** The home-auth row's Host settings form, whose `pairing` section the choices write. */
    pairingForm: ObservableSnapshot<ConfigFormSnapshot<PairingRowSettings>>
    /** The write state of that form. */
    pairingMutation: ObservableSnapshot<OptInMutation>
  }
  /** Read the pairing requests while the section shows. */
  startPairing: PairingSource['start']
  /** Write one field of the `pairing` section. */
  setPairing: PairingSettingsProps['set']
  /** Open the code box of a request. */
  openPairingCode: PairingSource['openCode']
  /** Decline a request. */
  declinePairing: PairingSource['decline']
}

/** Props the renderer binds for the section. */
export type DevicesSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunDevices'> & InjectFace<DevicesSectionInjected>

type Translate = DevicesSectionProps['t']

/**
 * The sentence for a failed request.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @param action - what was tried.
 * @returns the localized `LOOPBACK_REQUIRED` sentence, the Host's own sentence for another refusal, or the localized
 *   sentence for an unreachable Host or an unreadable answer.
 */
export function failureText(t: Translate, error: unknown, action: DevicesAction): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('loopback', { action: t(`action.${action}`) }) : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * A time of day as the unlock copy names it, in the copy's locale.
 * @param t - the Devices copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the hours and minutes.
 */
export function clockTime(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

/**
 * A moment as the section shows it, in the section's locale.
 * @param t - the section's copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the date and time.
 */
function formatTime(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

/**
 * The digits of a typed approval code, without the spaces and hyphens a person may type between them.
 * @param typed - the input's value.
 * @returns the code as the Host reads it.
 */
export function approvalCode(typed: string): string {
  return typed.replace(/[\s-]/g, '')
}

/** Whether a typed code is the eight digits a device shows. */
/** The digits of an approval code. */
const CODE_LENGTH = 8
const isCompleteCode = (typed: string): boolean => /^\d{8}$/.test(approvalCode(typed))

/**
 * Render the section.
 * @param props - the section's copy and the request function.
 * @returns the section.
 */
export function DevicesSection({
  t, fetch, useUnlock, usePairing, usePairingForm, usePairingMutation, startPairing, setPairing, openPairingCode, declinePairing,
}: DevicesSectionProps): ReactNode {
  const unlock = useUnlock(current => current)
  const pairing = usePairing(current => current)
  const pairingForm = usePairingForm(current => current)
  const pairingMutation = usePairingMutation(current => current)
  useEffect(() => startPairing(), [startPairing])
  const [reach, setReach] = useState<Loaded<ReachStatus | undefined>>({ kind: 'loading' })
  useEffect(() => {
    let current = true
    readReachStatus(fetch).then(
      (value) => { if (current) setReach({ kind: 'ready', value }) },
      (error: unknown) => { if (current) setReach({ kind: 'failed', text: failureText(t, error, 'status') }) },
    )
    return () => { current = false }
  }, [fetch, t])
  return <div className={css.section}>
    <h2 className={css.heading}>{t('title')}</h2>
    {reach.kind === 'ready' && reach.value === undefined
      ? <p className={css.line}>{t('reach.unavailable')}</p>
      : <>
        <p className={css.intro}>{t('intro')}</p>
        {unlock.place === 'device' ? <p className={css.line} data-device-face-id="">{t('unlock.section.faceId')}</p> : null}
        {reach.kind === 'failed' ? <p className={css.failed} role="alert">{reach.text}</p> : null}
        {reach.kind === 'ready' ? reach.value?.options.map(option => <ReachLine key={option.option} t={t} status={option} />) : null}
        {reach.kind === 'loading' ? null : <PairingSettings t={t} time={at => formatTime(t, at)} state={pairing} form={pairingForm}
          mutation={pairingMutation} set={setPairing} openCode={openPairingCode} decline={declinePairing} />}
        {reach.kind === 'loading' ? null : <DeviceManager t={t} fetch={fetch} hasOwner={reach.kind !== 'ready' || reach.value?.hasOwner !== false} place={unlock.place} />}
      </>}
  </div>
}

/**
 * One reach option's state line.
 * @param props - the copy and the option's state.
 * @returns the line.
 */
function ReachLine({ t, status }: { t: Translate; status: ReachOptionStatus }): ReactNode {
  switch (status.state) {
    case 'off':
      return <p className={css.line} data-reach-state="off">
        {t('reach.off')} <code className={css.command}>{REACH_ON_COMMAND}</code>
      </p>
    case 'ready':
      return <p className={css.line} data-reach-state="ready">
        {status.address === undefined ? t('reach.readyNoAddress') : t('reach.ready', { address: status.address })}
      </p>
    case 'blocked':
    case 'failed':
      return <p className={css.failed} data-reach-state={status.state}>{status.detail ?? t(`reach.${status.state}`)}</p>
    case 'starting':
    case 'degraded':
    case 'stopping':
      return <p className={css.line} data-reach-state={status.state}>{t(`reach.${status.state}`)}</p>
    /* v8 ignore next 2 -- ReachState is a closed union the answer's validation enforces. */
    default:
      return status.state satisfies never
  }
}

/**
 * The device list, its removal, the approval window and, at the computer, the unlock requests.
 * @param props - the copy, the request function, whether the home has an owner (without one the list is not requested),
 *   and the page's place: a device gets a line in place of "Add a device", and only a page known to be away from any
 *   device (`away`) reads the unlock requests.
 * @returns the list and the approval controls.
 */
function DeviceManager({ t, fetch, hasOwner, place }: { t: Translate; fetch: HostFetch; hasOwner: boolean; place: UnlockView['place'] }): ReactNode {
  const [devices, setDevices] = useState<Loaded<DeviceList | undefined>>({ kind: 'loading' })
  const [removing, setRemoving] = useState<Device | undefined>()
  const [removeFailure, setRemoveFailure] = useState<{ deviceId: Device['id']; text: string } | undefined>()
  const [windowClosesAt, setWindowClosesAt] = useState<number | undefined>()
  const [windowFailure, setWindowFailure] = useState<string | undefined>()
  const [pending, setPending] = useState<readonly PendingDevice[]>([])
  const [approveFailure, setApproveFailure] = useState<{ requestId: ApprovalRequestId; text: string } | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    if (!hasOwner) {
      setDevices({ kind: 'ready', value: undefined })
      return
    }
    try {
      setDevices({ kind: 'ready', value: await readDevices(fetch) })
    } catch (error) {
      setDevices({ kind: 'failed', text: failureText(t, error, 'list') })
    }
  }, [fetch, t, hasOwner])
  useEffect(() => { void refresh() }, [refresh])

  const closeWindow = useCallback((): void => {
    setWindowClosesAt(undefined)
    setPending([])
  }, [])

  // Read the pending requests every PENDING_POLL_MS while the window is open; the effect's cleanup stops it when the
  // window closes, a device is approved or the section unmounts.
  useEffect(() => {
    if (windowClosesAt === undefined) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let closesAt = windowClosesAt
    const poll = async (): Promise<void> => {
      if (Date.now() >= closesAt) {
        closeWindow()
        return
      }
      try {
        const answer = await readPendingDevices(fetch)
        if (stopped) return
        if (answer.windowClosesAt === null) {
          closeWindow()
          return
        }
        closesAt = answer.windowClosesAt
        setPending(answer.pending)
        timer = setTimeout(() => { void poll() }, PENDING_POLL_MS)
      } catch (error) {
        if (stopped) return
        closeWindow()
        setWindowFailure(failureText(t, error, 'approve'))
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [windowClosesAt, fetch, t, closeWindow])

  const addDevice = async (): Promise<void> => {
    setWindowFailure(undefined)
    setApproveFailure(undefined)
    try {
      setWindowClosesAt(await openApprovalWindow(fetch))
    } catch (error) {
      setWindowFailure(failureText(t, error, 'add'))
    }
  }

  const approve = async (requestId: ApprovalRequestId, typed: string): Promise<void> => {
    setApproveFailure(undefined)
    try {
      await approveDevice(fetch, requestId, approvalCode(typed))
    } catch (error) {
      setApproveFailure({ requestId, text: failureText(t, error, 'approve') })
      return
    }
    closeWindow()
    await refresh()
  }

  const cancel = async (requestId: ApprovalRequestId): Promise<void> => {
    setApproveFailure(undefined)
    try {
      await cancelPendingDevice(fetch, requestId)
    } catch (error) {
      setApproveFailure({ requestId, text: failureText(t, error, 'cancel') })
      return
    }
    setPending(current => current.filter(entry => entry.requestId !== requestId))
  }

  const remove = async (device: Device): Promise<void> => {
    setRemoving(undefined)
    setRemoveFailure(undefined)
    try {
      await removeDevice(fetch, device.id)
    } catch (error) {
      setRemoveFailure({ deviceId: device.id, text: failureText(t, error, 'remove') })
      return
    }
    await refresh()
  }

  const list = devices.kind === 'ready' ? devices.value?.devices ?? [] : []
  const strayApproveFailure = approveFailure !== undefined && !pending.some(request => request.requestId === approveFailure.requestId)
  return <>
    <h3 className={css.subheading}>{t('devices.title')}</h3>
    {devices.kind === 'failed' ? <p className={css.failed} role="alert">{devices.text}</p> : null}
    {devices.kind === 'ready' && list.length === 0 ? <p className={css.line}>{t('devices.none')}</p> : null}
    {list.length === 0 ? null : <ul className={css.list}>
      {list.map(device => <li key={device.id} className={css.row} data-device-id={device.id}>
        <div className={css.details}>
          <div className={css.title}>{device.label}</div>
          <div className={css.description}>{device.address === undefined ? device.platform : `${device.platform} · ${device.address}`}</div>
          <div className={css.description}>
            {t(device.approvedBy === 'local' ? 'device.approvedLocal' : 'device.approved', { time: formatTime(t, device.approvedAt) })}
            {' · '}
            {device.lastSignInAt === null ? t('device.neverSignedIn') : t('device.lastSignIn', { time: formatTime(t, device.lastSignInAt) })}
          </div>
          {removeFailure?.deviceId === device.id ? <div className={css.failed} role="alert">{removeFailure.text}</div> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setRemoving(device) }}>{t('device.remove')}</Button>
      </li>)}
    </ul>}
    {/* Adding a device is computer-only (E1): a device is told so instead of offered a button the home refuses. */}
    {place === 'device'
      ? <p className={css.line} data-add-at-computer="">{t('add.atComputer')}</p>
      : <div className={css.actions}>
        <Button variant="primary" disabled={windowClosesAt !== undefined} onClick={() => { void addDevice() }}>{t('add')}</Button>
      </div>}
    {devices.kind === 'ready' && devices.value !== undefined && place === 'away' ? <UnlockRequests t={t} fetch={fetch} devices={list} /> : null}
    {windowFailure === undefined ? null : <p className={css.failed} role="alert">{windowFailure}</p>}
    {windowClosesAt === undefined ? null : <div className={css.window}>
      <p className={css.line}>{t('waiting')}</p>
      {strayApproveFailure ? <p className={css.failed} role="alert">{approveFailure.text}</p> : null}
      {pending.map(request => <PendingRow key={request.requestId} t={t} request={request}
        failure={approveFailure?.requestId === request.requestId ? approveFailure.text : undefined}
        onApprove={typed => approve(request.requestId, typed)} onCancel={() => cancel(request.requestId)} />)}
    </div>}
    {removing === undefined ? null : <Dialog open onClose={() => { setRemoving(undefined) }}
      title={t('remove.title', { label: removing.label })} closeLabel={t('remove.close')}
      actions={<>
        <Button variant="secondary" onClick={() => { setRemoving(undefined) }}>{t('remove.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { void remove(removing) }}>{t('remove.confirm')}</Button>
      </>}>
      <p className={css.consent}>{t('remove.body')}</p>
    </Dialog>}
  </>
}

/**
 * One device asking for approval, with its code input.
 * @param props - the copy, the request, the refusal of its last approval or cancellation, the approval and the
 *   cancellation.
 * @returns the row.
 */
function PendingRow({ t, request, failure, onApprove, onCancel }: {
  t: Translate
  request: PendingDevice
  failure: string | undefined
  onApprove: (typed: string) => Promise<void>
  onCancel: () => Promise<void>
}): ReactNode {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  const submit = (): Promise<void> => run(() => onApprove(typed))
  return <div className={css.row} data-request-id={request.requestId}>
    <div className={css.details}>
      <div className={css.title}>{request.label}</div>
      <div className={css.description}>
        {request.platform} · {t('pending.requested', { time: formatTime(t, request.createdAt) })}
      </div>
      {failure === undefined ? null : <div className={css.failed} role="alert">{failure}</div>}
    </div>
    <form className={css.approve} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className={css.code}><CodeCells label={t('pending.code', { label: request.label })} length={CODE_LENGTH} value={typed} onChange={setTyped} autoComplete="one-time-code" disabled={busy} /></div>
      <Button variant="primary" size="sm" type="submit" disabled={busy || !isCompleteCode(typed)}>{t('pending.approve')}</Button>
      <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => { void run(onCancel) }}>{t('pending.cancel')}</Button>
    </form>
  </div>
}

/** The computer's list of unlock requests: loading, shown, hidden in a profile without the routes, or failed. */
type UnlockList = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: ElevationsAtComputer } | { readonly kind: 'absent' } | { readonly kind: 'failed'; readonly text: string }

/**
 * The computer's unlock requests and running unlocks, read every {@link ELEVATION_POLL_MS} while the section shows.
 * A request is approved by typing the code its device shows, or declined; a running unlock is ended with End.
 * @param props - the copy, the request function and the approved devices, which name each request.
 * @returns the list, or nothing in a profile without the routes.
 */
function UnlockRequests({ t, fetch, devices }: { t: Translate; fetch: HostFetch; devices: readonly Device[] }): ReactNode {
  const [list, setList] = useState<UnlockList>({ kind: 'loading' })
  const [failure, setFailure] = useState<{ id: string; text: string } | undefined>()
  const read = useCallback(async (): Promise<boolean> => {
    try {
      setList({ kind: 'ready', value: await readElevationsAtComputer(fetch) })
      return true
    } catch (error) {
      const answer = hostFailureOf(error)
      if (answer.kind !== 'unreachable' && answer.status === 404) {
        setList({ kind: 'absent' })
        return false
      }
      setList({ kind: 'failed', text: failureText(t, error, 'unlocks') })
      return true
    }
  }, [fetch, t])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const again = await read()
      if (!stopped && again) timer = setTimeout(() => { void poll() }, ELEVATION_POLL_MS)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [read])

  const labelOf = (deviceId: string): string => devices.find(device => device.id === deviceId)?.label ?? t('unlock.removedDevice')
  const revoke = async (id: ElevationRequestId | ElevationId): Promise<void> => {
    setFailure(undefined)
    try {
      await revokeElevation(fetch, id)
    } catch (error) {
      setFailure({ id, text: failureText(t, error, 'unlockRevoke') })
    }
    await read()
  }

  // Nothing waiting or running: an unlock admits nothing (A483), so the block stays out of the way.
  if (list.kind === 'absent' || list.kind === 'loading') return null
  if (list.kind === 'ready' && list.value.pending.length === 0 && list.value.running.length === 0) return null
  return <div className={css.unlock} data-unlock-requests="">
    <h3 className={css.subheading}>{t('unlock.requests.title')}</h3>
    <p className={css.line}>{t('unlock.requests.inert')}</p>
    {list.kind === 'failed' ? <p className={css.failed} role="alert">{list.text}</p> : null}
    {list.kind === 'ready' ? <>
      {list.value.pending.map(request => <UnlockRequestRow key={request.requestId} t={t} label={labelOf(request.deviceId)} request={request}
        failure={failure?.id === request.requestId ? failure.text : undefined} onDecline={() => revoke(request.requestId)} />)}
      {list.value.running.map(running => <div key={running.id} className={css.row} data-elevation-id={running.id}>
        <div className={css.details}>
          <div className={css.title}>{labelOf(running.deviceId)}</div>
          <div className={css.description}>{t('unlock.running.until', { time: clockTime(t, running.endsAt) })}</div>
          {failure?.id === running.id ? <div className={css.failed} role="alert">{failure.text}</div> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void revoke(running.id) }}>{t('unlock.running.end')}</Button>
      </div>)}
    </> : null}
  </div>
}

/**
 * One device asking for an unlock, which the computer can only decline: an approved unlock would admit nothing.
 * @param props - the copy, the device's name, the request, the refusal of its last decline, and the decline.
 * @returns the row.
 */
function UnlockRequestRow({ t, label, request, failure, onDecline }: {
  t: Translate
  label: string
  request: PendingElevation
  failure: string | undefined
  onDecline: () => Promise<void>
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  return <div className={css.row} data-elevation-request-id={request.requestId}>
    <div className={css.details}>
      <div className={css.title}>{label}</div>
      <div className={css.description}>{t('unlock.requests.asked', { time: formatTime(t, request.requestedAt) })}</div>
      {failure === undefined ? null : <div className={css.failed} role="alert">{failure}</div>}
    </div>
    <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => { void run(onDecline) }}>{t('unlock.requests.decline')}</Button>
  </div>
}
