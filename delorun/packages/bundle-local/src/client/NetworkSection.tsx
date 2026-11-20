/**
 * The Network settings section: each workspace's network for sandboxed commands and `web_fetch` (open, an allowlist of
 * hosts, or off), whether it follows the default, and its change. A change the Host refuses as an unconfirmed loosening
 * is sent again with `confirmed: true` only after the person confirms what it opens. The home serves the setting to its
 * own computer only, and the section says so in place elsewhere.
 */
import { useCallback, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { cardCss, SettingsCard } from '@delorun/settings-controls'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GateFailure } from './GateNotice.tsx'
import { useDangerousMode } from './dangerous-mode.ts'
import { failureSentence, isRefused, LOOPBACK_REQUIRED, type HostFetch, type Loaded } from './host-api.ts'
import {
  addedHosts, COMMON_HOSTS, comparableHosts, hostLines, NETWORK_UNCONFIRMED, readNetworks,
  sameNetwork, setNetwork,
  type CommonHostGroup, type NetworkAccess, type NetworkList, type NetworkWorkspace, type WorkspaceNetwork,
} from './network-api.ts'
import css from './NetworkSection.module.css'

/** The accesses in the order the section offers them. */
const SHOWN_ACCESSES: readonly NetworkAccess[] = ['open', 'allowlist', 'off']

/** The request function the plugin supplies. */
export interface NetworkSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the section. */
export type NetworkSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunNetwork'> & InjectFace<NetworkSectionInjected>

type Translate = NetworkSectionProps['t']

/**
 * The sentence for a failed request.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @param dangerous - whether dangerous mode holds, when the sentence says each change asks for Face ID or the PIN instead of going to the computer.
 * @returns the localized `LOOPBACK_REQUIRED` sentence, the Host's own sentence for another refusal, or the localized
 *   sentence for an unreachable Host or an unreadable answer.
 */
export function networkFailureText(t: Translate, error: unknown, dangerous = false): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t(dangerous ? 'loopbackConfirm' : 'loopback') : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * The sentence that states what a loosening opens.
 * @param t - the section's copy.
 * @param workspace - the workspace's title.
 * @param previous - the setting in effect.
 * @param next - the requested setting.
 * @returns the sentence for any host, for the added hosts, or for more of the network when no added host is known.
 */
export function looseningText(t: Translate, workspace: string, previous: WorkspaceNetwork, next: WorkspaceNetwork): string {
  if (next.access === 'open' && next.acceptAbstractSockets === true) return t('confirm.abstract', { workspace })
  if (next.access === 'open') return t('confirm.open', { workspace })
  const added = next.access === 'allowlist' ? addedHosts(previous, next.hosts) : []
  return added.length === 0 ? t('confirm.more', { workspace }) : t('confirm.hosts', { workspace, hosts: added.join(', ') })
}

/**
 * Render the section.
 * @param props - the section's copy and the request function.
 * @returns the section.
 */
export function NetworkSection({ t, fetch }: NetworkSectionProps): ReactNode {
  const dangerous = useDangerousMode(fetch)
  const [list, setList] = useState<Loaded<NetworkList | undefined>>({ kind: 'loading' })
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList({ kind: 'ready', value: await readNetworks(fetch) })
    } catch (error) {
      setList({ kind: 'failed', text: networkFailureText(t, error, dangerous) })
    }
  }, [fetch, t, dangerous])
  useEffect(() => { void refresh() }, [refresh])
  return <div className={css.section}>
    <h2 className={css.heading}>{t('title')}</h2>
    {list.kind === 'ready' && list.value === undefined
      ? <p className={css.line}>{t('unavailable')}</p>
      : <>
        <p className={css.intro}>{t('intro')}</p>
        <p className={css.risk} role="note">{t('risk')}</p>
        {list.kind === 'failed' ? <p className={css.failed} role="alert">{list.text}</p> : null}
        {list.kind === 'ready' && list.value !== undefined ? <WorkspaceList t={t} fetch={fetch} list={list.value} onSaved={refresh} /> : null}
      </>}
  </div>
}

/**
 * The store's problem, when there is one, and one row per workspace.
 * @param props - the copy, the request function, the list and what runs after a saved change.
 * @returns the rows.
 */
function WorkspaceList({ t, fetch, list, onSaved }: { t: Translate; fetch: HostFetch; list: NetworkList; onSaved: () => Promise<void> }): ReactNode {
  return <>
    {list.problem === undefined ? null : <p className={css.failed} role="alert">{t('problem', { problem: list.problem })}</p>}
    {list.workspaces.length === 0
      ? <p className={css.line}>{t('none')}</p>
      : <SettingsCard title={t('workspaces')}>
        <ul className={css.list}>
          {list.workspaces.map(workspace => <WorkspaceRow key={`${workspace.path}\n${JSON.stringify(workspace.network)}\n${String(workspace.own)}`}
            t={t} fetch={fetch} workspace={workspace} defaultNetwork={list.default} locked={list.problem !== undefined} onSaved={onSaved} />)}
        </ul>
      </SettingsCard>}
  </>
}

/** A change waiting for the person's confirmation: the setting to send, absent for the default, and what it opens. */
interface PendingLoosening {
  readonly network: WorkspaceNetwork | undefined
  readonly text: string
}

/**
 * One workspace: its title and folder, whether it follows the default, the access choice, the allowlist editor, Use
 * default, and the confirmation of a loosening. Each change is sent as soon as it is made: a choice of access, the
 * switch, the common hosts and a changed host list when the field loses focus.
 * @param props - the copy, the request function, the workspace, the default, whether changes are refused, and what runs
 *   after a saved change.
 * @returns the row.
 */
function WorkspaceRow({ t, fetch, workspace, defaultNetwork, locked, onSaved }: {
  t: Translate
  fetch: HostFetch
  workspace: NetworkWorkspace
  defaultNetwork: WorkspaceNetwork
  locked: boolean
  onSaved: () => Promise<void>
}): ReactNode {
  const [access, setAccess] = useState<NetworkAccess>(workspace.network.access)
  const [hostsText, setHostsText] = useState(workspace.network.hosts.join('\n'))
  const [accept, setAccept] = useState(workspace.network.acceptAbstractSockets === true)
  const [offering, setOffering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const dangerous = useDangerousMode(fetch)
  const [confirming, setConfirming] = useState<PendingLoosening | undefined>()
  const draft: WorkspaceNetwork = { access, hosts: hostLines(hostsText), ...access === 'open' && accept ? { acceptAbstractSockets: true } : {} }
  const id = useId()

  /** Puts the controls back to the setting in effect, after a refused or cancelled change. */
  const revert = (): void => {
    setAccess(workspace.network.access)
    setHostsText(workspace.network.hosts.join('\n'))
    setAccept(workspace.network.acceptAbstractSockets === true)
  }

  const save = async (network: WorkspaceNetwork | undefined, confirmed: boolean): Promise<void> => {
    setFailure(undefined)
    setBusy(true)
    try {
      await setNetwork(fetch, { path: workspace.path, ...network === undefined ? {} : { network }, confirmed })
    } catch (error) {
      if (!confirmed && isRefused(error, NETWORK_UNCONFIRMED)) {
        setConfirming({ network, text: looseningText(t, workspace.title, workspace.network, network ?? defaultNetwork) })
      } else {
        setFailure(error)
        revert()
      }
      return
    } finally {
      setBusy(false)
    }
    await onSaved()
  }

  /** Sends the setting the controls now show when it differs from the one in effect. */
  const commit = (next: WorkspaceNetwork): void => {
    if (!sameNetwork(next, workspace.network)) void save(next, false)
  }

  const choose = (value: NetworkAccess): void => {
    setAccess(value)
    commit({ access: value, hosts: hostLines(hostsText), ...value === 'open' && accept ? { acceptAbstractSockets: true } : {} })
  }

  const accepting = (value: boolean): void => {
    setAccept(value)
    commit({ access, hosts: hostLines(hostsText), ...access === 'open' && value ? { acceptAbstractSockets: true } : {} })
  }

  const addCommon = (group: CommonHostGroup): void => {
    const lines = hostLines(hostsText)
    const present = new Set(comparableHosts(lines))
    const added = [...lines, ...COMMON_HOSTS[group].filter(host => !present.has(host))]
    setHostsText(added.join('\n'))
    commit({ access, hosts: added, ...access === 'open' && accept ? { acceptAbstractSockets: true } : {} })
  }

  const accessName = (value: NetworkAccess): string => t(`access.${value}`)
  return <li className={`${cardCss.block} ${css.row}`} data-workspace-path={workspace.path}>
    <div className={css.head}>
      <div className={css.details}>
        <div className={css.title}>{workspace.title}</div>
        <div className={css.description}>{workspace.path}</div>
        <div className={css.description}>
          {t(workspace.own ? 'row.own' : 'row.default', { access: accessName(defaultNetwork.access) })}
        </div>
      </div>
      <SegmentedControl id={id} label={t('access.label', { workspace: workspace.title })} value={access}
        disabled={locked || busy} options={SHOWN_ACCESSES.map(value => ({ value, label: accessName(value) }))}
        onChange={choose} />
    </div>
    <div className={css.panel} role="tabpanel" id={`${id}-${access}-panel`} aria-labelledby={`${id}-${access}`}>
      <p className={css.description}>{t(`access.${access}.description`)}</p>
      {access === 'open' ? <div className={css.accept}>
        <div className={css.details}>
          <div className={css.title}>{t('abstract.title')}</div>
          <div className={css.description}>{t('abstract.description')}</div>
        </div>
        <Switch checked={accept} label={t('abstract.title')} disabled={locked || busy} onChange={accepting} />
      </div> : null}
      {access === 'allowlist' ? <>
        <label className={css.hostsLabel} htmlFor={`${id}-hosts`}>{t('hosts.label', { workspace: workspace.title })}</label>
        <textarea id={`${id}-hosts`} className={css.hosts} rows={5} value={hostsText} disabled={locked || busy}
          spellCheck={false} autoCapitalize="off" autoComplete="off"
          onChange={(event) => { setHostsText(event.target.value) }} onBlur={() => { commit(draft) }} />
        <p className={css.description}>{t('hosts.hint')}</p>
        <div className={css.common}>
          <Button variant="outline" size="sm" aria-expanded={offering} disabled={locked || busy}
            onClick={() => { setOffering(open => !open) }}>{t('common.add')}</Button>
          {offering ? (Object.keys(COMMON_HOSTS) as CommonHostGroup[]).map(group =>
            <Button key={group} size="sm" disabled={locked || busy} onClick={() => { addCommon(group) }}>{t(`common.${group}`)}</Button>) : null}
        </div>
        {offering ? <p className={css.description}>{t('common.hint')}</p> : null}
      </> : null}
    </div>
    {failure === undefined ? null : <GateFailure t={t} error={failure} text={networkFailureText(t, failure, dangerous)} className={css.failed} />}
    {workspace.own ? <div className={css.actions}>
      <Button variant="outline" size="sm" disabled={locked || busy}
        onClick={() => { void save(undefined, false) }}>{t('useDefault')}</Button>
    </div> : null}
    {confirming === undefined ? null : <Modal open onClose={() => { setConfirming(undefined); revert() }}
      title={t('confirm.title', { workspace: workspace.title })} closeLabel={t('confirm.close')}
      footer={<>
        <Button variant="outline" onClick={() => { setConfirming(undefined); revert() }}>{t('confirm.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => {
          const { network } = confirming
          setConfirming(undefined)
          void save(network, true)
        }}>{t('confirm.accept')}</Button>
      </>}>
      <p className={css.consent}>{confirming.text}</p>
    </Modal>}
  </li>
}
