/**
 * The Devices settings section: the reach state, the approved devices with their removal, and the approval of a new
 * device while the approval window is open. Every request goes to the home through the injected `fetch`; the home
 * refuses device management to a remote studio, and the section says so in place.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  approveDevice, cancelPendingDevice, LOOPBACK_REQUIRED, openApprovalWindow, PENDING_POLL_MS, readDevices, readPendingDevices,
  readReachStatus, removeDevice,
  type ApprovalRequestId, type Device, type DeviceList, type HostFetch, type PendingDevice, type ReachOptionStatus,
  type ReachStatus,
} from './devices-api.ts'
import { failureSentence, type Loaded } from './host-api.ts'
import css from './DevicesSection.module.css'

/** The command that turns remote access on, which the section shows while it is off. */
export const REACH_ON_COMMAND = 'delorun reach on tailscale'

/** What the section names in a refusal that needs the home's own computer. */
export type DevicesAction = 'status' | 'list' | 'add' | 'approve' | 'cancel' | 'remove'

/** The request function the plugin supplies. */
export interface DevicesSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the section. */
export type DevicesSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloDevices'> & InjectFace<DevicesSectionInjected>

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
const isCompleteCode = (typed: string): boolean => /^\d{8}$/.test(approvalCode(typed))

/**
 * Render the section.
 * @param props - the section's copy and the request function.
 * @returns the section.
 */
export function DevicesSection({ t, fetch }: DevicesSectionProps): ReactNode {
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
        {reach.kind === 'failed' ? <p className={css.failed} role="alert">{reach.text}</p> : null}
        {reach.kind === 'ready' ? reach.value?.options.map(option => <ReachLine key={option.option} t={t} status={option} />) : null}
        {reach.kind === 'loading' ? null : <DeviceManager t={t} fetch={fetch} />}
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
 * The device list, its removal, and the approval window.
 * @param props - the copy and the request function.
 * @returns the list and the approval controls.
 */
function DeviceManager({ t, fetch }: { t: Translate; fetch: HostFetch }): ReactNode {
  const [devices, setDevices] = useState<Loaded<DeviceList | undefined>>({ kind: 'loading' })
  const [removing, setRemoving] = useState<Device | undefined>()
  const [removeFailure, setRemoveFailure] = useState<{ deviceId: Device['id']; text: string } | undefined>()
  const [windowClosesAt, setWindowClosesAt] = useState<number | undefined>()
  const [windowFailure, setWindowFailure] = useState<string | undefined>()
  const [pending, setPending] = useState<readonly PendingDevice[]>([])
  const [approveFailure, setApproveFailure] = useState<{ requestId: ApprovalRequestId; text: string } | undefined>()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDevices({ kind: 'ready', value: await readDevices(fetch) })
    } catch (error) {
      setDevices({ kind: 'failed', text: failureText(t, error, 'list') })
    }
  }, [fetch, t])
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
          <div className={css.description}>{device.platform} · {device.address}</div>
          <div className={css.description}>
            {t(device.approvedBy === 'local' ? 'device.approvedLocal' : 'device.approved', { time: formatTime(t, device.approvedAt) })}
            {' · '}
            {device.lastSignInAt === null ? t('device.neverSignedIn') : t('device.lastSignIn', { time: formatTime(t, device.lastSignInAt) })}
          </div>
          {removeFailure?.deviceId === device.id ? <div className={css.failed} role="alert">{removeFailure.text}</div> : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => { setRemoving(device) }}>{t('device.remove')}</Button>
      </li>)}
    </ul>}
    <div className={css.actions}>
      <Button variant="primary" disabled={windowClosesAt !== undefined} onClick={() => { void addDevice() }}>{t('add')}</Button>
    </div>
    {windowFailure === undefined ? null : <p className={css.failed} role="alert">{windowFailure}</p>}
    {windowClosesAt === undefined ? null : <div className={css.window}>
      <p className={css.line}>{t('waiting')}</p>
      {strayApproveFailure ? <p className={css.failed} role="alert">{approveFailure.text}</p> : null}
      {pending.map(request => <PendingRow key={request.requestId} t={t} request={request}
        failure={approveFailure?.requestId === request.requestId ? approveFailure.text : undefined}
        onApprove={typed => approve(request.requestId, typed)} onCancel={() => cancel(request.requestId)} />)}
    </div>}
    {removing === undefined ? null : <Modal open onClose={() => { setRemoving(undefined) }}
      title={t('remove.title', { label: removing.label })} closeLabel={t('remove.close')}
      footer={<>
        <Button variant="outline" onClick={() => { setRemoving(undefined) }}>{t('remove.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => { void remove(removing) }}>{t('remove.confirm')}</Button>
      </>}>
      <p className={css.consent}>{t('remove.body')}</p>
    </Modal>}
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
      <Input className={css.code as string} value={typed} inputMode="numeric" autoComplete="off"
        aria-label={t('pending.code', { label: request.label })} placeholder={t('pending.codePlaceholder')}
        onChange={(event) => { setTyped(event.target.value) }} />
      <Button variant="primary" size="sm" type="submit" disabled={busy || !isCompleteCode(typed)}>{t('pending.approve')}</Button>
      <Button size="sm" type="button" disabled={busy} onClick={() => { void run(onCancel) }}>{t('pending.cancel')}</Button>
    </form>
  </div>
}
