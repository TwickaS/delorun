/**
 * `@delo/bundle-local`'s browser half: the Privacy section in Settings, with the consent switches for upstream's two
 * opt-ins, DeepSeek's session-log upload (`session-log-deepseek`) and the desktop app's analytics
 * (`product-analytics`); the plugin downloads section in Settings, Plugins, with the npm mirror switch (`npmMirror` of
 * `delo-plugin-install-check`); the General row with the switch of Delo's release check (`delo-update-check`) and the
 * General row that names both versions; and
 * the About section with the licence and the project's links. Each switch writes only its own row's field, `enabled`
 * or `npmMirror`, through upstream's configuration form, into the active profile's `cordis.patch.yml`.
 *
 * It also registers the Devices section, which shows the reach state, manages the devices the home approved and answers
 * their requests to unlock sensitive actions; the Network section, which sets each workspace's network for sandboxed
 * commands and `web_fetch` at the home's own computer; the notice that an answer the home refused, such as a full-access
 * grant from a remote studio, must be given at the home's own computer; and the remote studio's unlock, which turns a
 * call refused with `elevation-required:` into a request to the computer and shows a banner while sensitive actions are
 * unlocked. The consent surfaces of Delo's two consent plugins come from here too: the full-access consent,
 * which upstream's permission control asks through the `permissionSwitchConsent` service before a chat switches to
 * full access in a workspace without a grant; the approval card's action for a request that asks for full access; the
 * review of a waiting stdio MCP server and the notice that one waits; the Permissions section, which lists every
 * full-access grant and every waiting or allowed MCP server with a one-click revoke; and the External agents section,
 * which holds the external-agent consent's switch and run time limit, written to `delo-delegation-consent`'s row through
 * upstream's configuration form, and lists each agent allowed to start in a workspace without asking with its revoke.
 * Each reads its plugin's routes, which answer only the home's own computer, but for the waiting servers' names, and
 * are absent while the plugin's switch is off.
 *
 * It registers the trust badge at the sidebar's foot (`sidebar.footer.action`), which opens the trust panel: what this
 * Delo runs and how much of it was checked, from the `delo-trust` row's bill, with Check now on the home's own computer.
 *
 * Other surfaces open the sections with `ctx.settingsShell.openSection(PRIVACY_SECTION_ID)`,
 * `ctx.settingsShell.openSection(DEVICES_SECTION_ID)` or `ctx.settingsShell.openSection(NETWORK_SECTION_ID)`.
 * @module @delo/bundle-local/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'connection/reset' event merge and the connection service's type.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { applyUnlockConnection } from './unlock-connection.ts'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'settings.section' and 'settings.section.icon' SlotMap entries and the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.settingsLayout Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: the 'sidebar.brand.mark' and 'sidebar.brand.name' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconLinkOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { SETUP_OPT_IN_ROWS, SETUP_UPDATE_CHECK_ROW } from '@delo/contract-setup-answers'
import { DeloBrandMark, DeloBrandName } from './brand.tsx'
import { acknowledgeNotice, DeloNotice, noticeAcknowledged, type DeloNoticeInjected } from './DeloNotice.tsx'
import { DeloVersionRow, type DeloVersionRowInjected } from './DeloVersionRow.tsx'
import { en as devicesEn, zh as devicesZh, type DevicesLocaleKey } from './devices-locales.ts'
import type { HostFetch } from './devices-api.ts'
import { DevicesSection, type DevicesSectionInjected } from './DevicesSection.tsx'
import { en, zh, type PrivacyLocaleKey } from './locales.ts'
import { en as versionsEn, zh as versionsZh, type VersionsLocaleKey } from './versions-locales.ts'
import { VersionsSection, type VersionsSectionInjected } from './VersionsSection.tsx'
import { en as networkEn, zh as networkZh, type NetworkLocaleKey } from './network-locales.ts'
import { NetworkSection, type NetworkSectionInjected } from './NetworkSection.tsx'
import { OPT_IN_FIELDS, OptIn, type OptInId, type OptInSettings } from './opt-in.ts'
import { PluginInstallsSection, type PluginInstallsSectionInjected } from './PluginInstallsSection.tsx'
import { PrivacySection, type PrivacySectionInjected } from './PrivacySection.tsx'
import { UpdateCheckRow, type UpdateCheckRowInjected } from './UpdateCheckRow.tsx'
import { VersionsRow, type VersionsRowInjected } from './VersionsRow.tsx'
import { AboutSection } from './AboutSection.tsx'
import { overrideTitle } from './title.ts'
import { readVersions } from './versions.ts'
import { createRemoteNoticeSource, RemoteNotice } from './RemoteNotice.tsx'
import { createPinSource, type PinSource } from './pin-lock.ts'
import { en as pinEn, zh as pinZh, type PinLocaleKey } from './pin-locales.ts'
import { PinLock } from './PinLock.tsx'
import { attachPinTriggers } from './pin-triggers.ts'
import { createUnlockSource, type UnlockSource } from './unlock.ts'
import { UnlockOverlay } from './UnlockOverlay.tsx'
import { trustApi, TrustStore, type TrustApi } from './trust-api.ts'
import { TrustBadge, type TrustBadgeInjected } from './TrustBadge.tsx'
import { en as trustEn, zh as trustZh, type TrustLocaleKey } from './trust-locales.ts'
// Type-only: the ctx.permissionSwitchConsent merge.
import type { PermissionSwitchConsent } from '@deepseek-ai/dsh-client-ui-permission-presets/client'
// Type-only: the 'conversation.approval.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
// Type-only: ctx.sessions, whose live sessions take the composer's `/permission <preset>` command.
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client'
import { en as consentsEn, zh as consentsZh, type ConsentsLocaleKey } from './consents-locales.ts'
import { ConsentToast, createConsentToastSource } from './ConsentToast.tsx'
import { AllowForChat, ChatSwitchRefused, type AllowForChatInjected } from './AllowForChat.tsx'
import { FullAccessAction, type FullAccessActionInjected } from './FullAccessAction.tsx'
import { ExternalAgentAction, type ExternalAgentActionInjected } from './ExternalAgentAction.tsx'
import { confirmPermissionSwitch, createFullAccessConsentSource, FullAccessConsent, ownsPermissionConfirmation } from './FullAccessConsent.tsx'
import { createMcpReviewSource, McpServerReview } from './McpServerReview.tsx'
import { PairingNotice, type PairingNoticeInjected } from './PairingNotice.tsx'
import { createPairingSource } from './pairing-source.ts'
import { PairingWriter, type PairingRowSettings } from './pairing-writer.ts'
import { HOME_AUTH_ROW } from '@delo/home-auth/wire'
import { McpWaitingNotice, type McpWaitingNoticeInjected } from './McpWaitingNotice.tsx'
import { DangerousBadge, type DangerousBadgeInjected } from './DangerousBadge.tsx'
import { ExternalAgentsSection, type ExternalAgentsSectionInjected } from './ExternalAgentsSection.tsx'
import { PermissionsSection, type PermissionsSectionInjected } from './PermissionsSection.tsx'
import { DELEGATION_CONSENT_ROW, type DelegationConsentSettings } from '@delo/plugin-delegation-consent/wire'

export type { PrivacyLocaleKey } from './locales.ts'
export type { DevicesLocaleKey } from './devices-locales.ts'
export type { PinLocaleKey } from './pin-locales.ts'
export type { PinOutcome, PinSource, PinView } from './pin-lock.ts'
export type { PinLockProps } from './PinLock.tsx'
export type { TrustLocaleKey } from './trust-locales.ts'
export type { TrustBadgeInjected, TrustBadgeProps } from './TrustBadge.tsx'
export { badgeLabel, formatTime, rowStateLabel, TrustBadge, VERIFY_COMMAND } from './TrustBadge.tsx'
export {
  fetchTrustBill, postTrustCheck, trustApi, TrustBillSchema, TrustStore,
  type TrustApi, type TrustCheckOutcome, type TrustCheckState,
} from './trust-api.ts'
export type { ConsentsLocaleKey } from './consents-locales.ts'
export type { ExternalAgentsSectionInjected, ExternalAgentsSectionProps } from './ExternalAgentsSection.tsx'
export type { PermissionsSectionInjected, PermissionsSectionProps } from './PermissionsSection.tsx'
export type { FullAccessConsentProps, FullAccessConsentSource, FullAccessConsentState } from './FullAccessConsent.tsx'
export type { FullAccessActionInjected, FullAccessActionProps } from './FullAccessAction.tsx'
export type { ExternalAgentActionInjected, ExternalAgentActionProps } from './ExternalAgentAction.tsx'
export type { McpReviewSource, McpReviewState, McpServerReviewProps } from './McpServerReview.tsx'
export type { McpWaitingNoticeInjected, McpWaitingNoticeProps } from './McpWaitingNotice.tsx'
export type { DangerousBadgeInjected, DangerousBadgeProps } from './DangerousBadge.tsx'
export type { ConsentToastProps, ConsentToastSource, ConsentToastState } from './ConsentToast.tsx'
export type { NetworkLocaleKey } from './network-locales.ts'
export type { VersionsLocaleKey } from './versions-locales.ts'
export type { VersionsSectionInjected, VersionsSectionProps } from './VersionsSection.tsx'
export { PROFILE_VERSION_ROUTES, type VersionChanges, type VersionEntry, type VersionsAnswer } from './versions-api.ts'
export type { DeloVersionRowInjected, DeloVersionRowProps } from './DeloVersionRow.tsx'
export { readVersions, VERSIONS_GLOBAL, type DeloVersions } from './versions.ts'
export type { OptInId, OptInMutation, OptInSettings } from './opt-in.ts'
export type { OptInRowProps } from './OptInRow.tsx'
export type { PrivacyOptInId, PrivacySectionInjected, PrivacySectionProps } from './PrivacySection.tsx'
export type { UpdateCheckRowInjected, UpdateCheckRowProps } from './UpdateCheckRow.tsx'
export type { VersionsRowInjected, VersionsRowProps } from './VersionsRow.tsx'
export type { AboutSectionProps } from './AboutSection.tsx'
export type { DevicesSectionInjected, DevicesSectionProps } from './DevicesSection.tsx'
export type { UnlockDialog, UnlockOutcome, UnlockSource, UnlockView } from './unlock.ts'
export type { UnlockOverlayProps } from './UnlockOverlay.tsx'
export type { NetworkSectionInjected, NetworkSectionProps } from './NetworkSection.tsx'
export {
  DEVICE_ROUTES, HostRequestError, readReachStatus, REACH_STATES,
  type HostFailure, type HostFetch, type ReachOptionStatus, type ReachState, type ReachStatus,
} from './devices-api.ts'
export {
  NETWORK_ACCESSES, NETWORK_ROUTES, readNetworks,
  type NetworkAccess, type NetworkList, type NetworkWorkspace, type WorkspaceNetwork,
} from './network-api.ts'

/** What `ctx.deloNotice` shares: the acknowledgement of Delo's preview notice on this browser. */
export interface DeloNoticeService {
  /**
   * Whether this browser acknowledged the current notice version.
   * @returns true once the current version is recorded.
   */
  acknowledged(): boolean
  /** Record the current notice version on this browser, so the notice step completes without showing. */
  acknowledge(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's preview notice acknowledgement; a flow that shows the notice's copy itself records it here. */
    deloNotice: DeloNoticeService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The copy of the Privacy and About sections and of the release check's and versions' General rows. */
    'deloPrivacy': PrivacyLocaleKey
    /** The Devices section's copy and the remote studio's refused-answer notice. */
    'deloDevices': DevicesLocaleKey
    /** The PIN lock screen's copy. */
    'deloPin': PinLocaleKey
    /** The trust badge's and the trust panel's copy. */
    'deloTrust': TrustLocaleKey
    /** The full-access consent, the approval card's action, the MCP server review and notice, and the Permissions and External agents sections. */
    'deloConsents': ConsentsLocaleKey
    /** The Network section's copy. */
    'deloNetwork': NetworkLocaleKey
    /** The Setup versions section's copy. */
    'deloVersions': VersionsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloPrivacy'

/** Dictionary namespace of the Devices section and the remote refused-answer notice. */
export const DEVICES_NS = 'deloDevices'

/** Dictionary namespace of the PIN lock screen. */
export const PIN_NS = 'deloPin'

/** The `shell.overlay` id of the PIN lock screen. */
export const PIN_LOCK_OVERLAY_ID = 'delo-pin-lock'

/** Dictionary namespace of the Network section. */
export const NETWORK_NS = 'deloNetwork'

/** Dictionary namespace of the Setup versions section. */
export const VERSIONS_NS = 'deloVersions'

/** The `settings.section` id of the Privacy section, which setup and other surfaces open. */
export const PRIVACY_SECTION_ID = 'delo-privacy'

/** The section's place in the Settings navigation: after upstream's Plugins section (15). */
export const PRIVACY_SECTION_ORDER = 20

/** The `settings.section` id of the plugin downloads section, which holds the npm mirror switch. */
export const PLUGIN_INSTALLS_SECTION_ID = 'delo-plugin-installs'

/** The plugin downloads section's place in the Settings navigation: right after upstream's Plugins section (15). */
export const PLUGIN_INSTALLS_SECTION_ORDER = 16

/** The row of Delo's release check, whose `enabled` is C16 switch `update_check`; setup's `updateCheck` answer writes the same field. */
export const UPDATE_CHECK_ROW = SETUP_UPDATE_CHECK_ROW

/** The row whose `npmMirror` the npm mirror switch writes: the plugin install check's. */
export const NPM_MIRROR_ROW = 'delo-plugin-install-check'

/** The Host row each switch writes: the opt-ins and the release check from C11's answer-to-row mapping, and the npm mirror's. */
export const OPT_IN_ROWS: Readonly<Record<OptInId, string>> = {
  sessionLog: SETUP_OPT_IN_ROWS.sessionLogUpload,
  analytics: SETUP_OPT_IN_ROWS.desktopAnalytics,
  updateCheck: UPDATE_CHECK_ROW,
  npmMirror: NPM_MIRROR_ROW,
}

/**
 * The version row's id and rank: the stock row's id at a lower shadowing rank, so it renders in that row's place and
 * keeps its place in grouped Settings.
 */
export const VERSION_ROW = { id: 'current-version', priority: -1 } as const

/** The General row of the release check, placed just before upstream's version row (100) in the flat General list. */
export const UPDATE_CHECK_ITEM = { id: 'delo-update-check', order: 98 } as const

/**
 * The General row that names both versions on one line, right after the release check's row. It shows only while a
 * Settings layout is in force, whose Updates card holds it; the flat list keeps the version row alone.
 */
export const VERSIONS_ITEM = { id: 'delo-versions', order: 99 } as const

/** The `settings.section` id of the About section. */
export const ABOUT_SECTION_ID = 'delo-about'

/** The About section's place in the Settings navigation: after the Network section. */
export const ABOUT_SECTION_ORDER = 25

/** The `settings.section` id of the Devices section, which onboarding and other surfaces open. */
export const DEVICES_SECTION_ID = 'delo-devices'

/** The Devices section's place in the Settings navigation: right after Privacy. */
export const DEVICES_SECTION_ORDER = 21

/** The `settings.section` id of the Network section. */
export const NETWORK_SECTION_ID = 'delo-network'

/** The Network section's place in the Settings navigation: right after External agents. */
export const NETWORK_SECTION_ORDER = 24

/** The `settings.section` id of the Setup versions section. */
export const SETUP_VERSIONS_SECTION_ID = 'delo-setup-versions'

/** The Setup versions section's place in the Settings navigation: right after Network. */
export const SETUP_VERSIONS_SECTION_ORDER = 24.5

/** The `shell.overlay` id of the remote studio's refused-answer notice. */
export const REMOTE_NOTICE_ID = 'delo-remote-full-access'

/** The `shell.overlay` id of the remote studio's unlock dialog, banner and locked-again notice. */
export const UNLOCK_OVERLAY_ID = 'delo-unlock'

/** Dictionary namespace of the trust badge and its panel. */
export const TRUST_NS = 'deloTrust'

/** The `sidebar.footer.action` id and order of the trust badge: after the foot's other actions, ending its row. */
export const TRUST_BADGE = { id: 'delo-trust', order: 10 } as const

/** Dictionary namespace of the consent surfaces. */
export const CONSENTS_NS = 'deloConsents'

/** The `settings.section` id of the Permissions section. */
export const PERMISSIONS_SECTION_ID = 'delo-permissions'

/** The Permissions section's place in the Settings navigation: right after Devices. */
export const PERMISSIONS_SECTION_ORDER = 22

/** The `settings.section` id of the External agents section. */
export const EXTERNAL_AGENTS_SECTION_ID = 'delo-external-agents'

/** The External agents section's place in the Settings navigation: right after Permissions. */
export const EXTERNAL_AGENTS_SECTION_ORDER = 23

/** The `shell.overlay` id of the full-access consent. */
export const FULL_ACCESS_CONSENT_ID = 'delo-full-access-consent'

/** The `shell.overlay` id of the MCP server review. */
export const MCP_REVIEW_ID = 'delo-mcp-review'

/** The `shell.overlay` id of the notice and code box for a device that asks to connect without an approval window. */
export const PAIRING_NOTICE_ID = 'delo-pairing-notice'

/** The `shell.overlay` id of the notice that an MCP server waits. */
export const MCP_WAITING_NOTICE_ID = 'delo-mcp-waiting'

/** The `shell.overlay` id of the toast that shows the outcome of an answer given outside Settings. */
export const CONSENT_TOAST_ID = 'delo-consents-toast'

/** The `conversation.approval.action` id of the full-access action. */
export const FULL_ACCESS_ACTION_ID = 'delo-full-access'

/** The `conversation.approval.choice` id of the "Allow for this chat" choice. */
export const ALLOW_FOR_CHAT_ID = 'delo-allow-for-chat'

/** The `conversation.approval.action` id of the external-agent action. */
export const EXTERNAL_AGENT_ACTION_ID = 'delo-external-agent'

/** Required services; `sessions` is read by the "Allow for this chat" choice to switch a live chat. */
export const inject = ['slots', 'locale', 'configForms', 'sessions', 'connection']

/**
 * Register the Privacy, plugin downloads, About, Devices and Network sections, the release check's General row, the Delo sidebar brand, the
 * product name as the document title, Delo's preview notice, `ctx.deloNotice`, the refused-answer notice, and, when the
 * harness printed both versions into the page, the version row that names Delo's version and the DeepSeek Harness
 * version and, while a Settings layout is in force, the General row that names both on one line. All of them come from this bundle's
 * `delo-privacy` row, which the parity composition leaves disabled, so upstream's brand, title and notice stay in the
 * parity composition.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  applyUnlockConnection(ctx)
  const t = ctx.locale.bind(NS)
  ctx.provide('deloNotice', { acknowledged: () => noticeAcknowledged(), acknowledge: () => { acknowledgeNotice() } } satisfies DeloNoticeService)
  ctx.effect(() => overrideTitle(ctx.locale), 'delo-privacy: the product name as the document title')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, DeloBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, DeloBrandName)
    }))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'delo-notice',
    order: -100,
    inject: (): DeloNoticeInjected => ({ t: key => t(key) }),
  }, DeloNotice))
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-privacy: section dictionaries')
  const optIns: Record<OptInId, OptIn> = {
    sessionLog: new OptIn(ctx.configForms.get<OptInSettings>(OPT_IN_ROWS.sessionLog)),
    analytics: new OptIn(ctx.configForms.get<OptInSettings>(OPT_IN_ROWS.analytics)),
    updateCheck: new OptIn(ctx.configForms.get<OptInSettings>(OPT_IN_ROWS.updateCheck)),
    npmMirror: new OptIn(ctx.configForms.get<OptInSettings>(OPT_IN_ROWS.npmMirror), OPT_IN_FIELDS.npmMirror),
  }
  const face = (): PrivacySectionInjected => ({
    hooks: {
      sessionLog: optIns.sessionLog.form,
      sessionLogMutation: optIns.sessionLog.state,
      analytics: optIns.analytics.form,
      analyticsMutation: optIns.analytics.state,
    },
    setEnabled: (id, enabled) => optIns[id].setEnabled(enabled),
  })
  const installsFace = (): PluginInstallsSectionInjected => ({
    hooks: { npmMirror: optIns.npmMirror.form, npmMirrorMutation: optIns.npmMirror.state },
    setEnabled: enabled => optIns.npmMirror.setEnabled(enabled),
  })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: UPDATE_CHECK_ITEM.id,
    order: UPDATE_CHECK_ITEM.order,
    locale: NS,
    inject: (): UpdateCheckRowInjected => ({
      hooks: { updateCheck: optIns.updateCheck.form, updateCheckMutation: optIns.updateCheck.state },
      setEnabled: enabled => optIns.updateCheck.setEnabled(enabled),
    }),
  }, UpdateCheckRow))
  const versions = readVersions()
  if (versions !== undefined) {
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: VERSION_ROW.id,
      priority: VERSION_ROW.priority,
      inject: (): DeloVersionRowInjected => ({ versions, t: (key, params) => t(key, params) }),
    }, DeloVersionRow))
    ctx.inject(['settingsLayout'], (laid) => {
      laid.slots.inject('settings.general.item', () => {
        let unregister: (() => void) | undefined
        const follow = (): void => {
          const inForce = laid.settingsLayout.getSnapshot() !== undefined
          if (inForce && unregister === undefined) {
            unregister = laid.slots.register({
              name: 'settings.general.item',
              id: VERSIONS_ITEM.id,
              order: VERSIONS_ITEM.order,
              locale: NS,
              inject: (): VersionsRowInjected => ({ versions }),
            }, VersionsRow)
          } else if (!inForce && unregister !== undefined) {
            unregister()
            unregister = undefined
          }
        }
        follow()
        const unsubscribe = laid.settingsLayout.subscribe(follow)
        return () => {
          unsubscribe()
          unregister?.()
        }
      })
    })
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PRIVACY_SECTION_ID,
    order: PRIVACY_SECTION_ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: face,
  }, PrivacySection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_INSTALLS_SECTION_ID,
    order: PLUGIN_INSTALLS_SECTION_ORDER,
    label: () => t('installs.nav'),
    locale: NS,
    inject: installsFace,
  }, PluginInstallsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ABOUT_SECTION_ID,
    order: ABOUT_SECTION_ORDER,
    label: () => t('about.nav'),
    locale: NS,
  }, AboutSection))
  ctx.effect(() => ctx.locale.register(DEVICES_NS, { en: devicesEn, zh: devicesZh }), 'delo-devices: section dictionaries')
  const devicesT = ctx.locale.bind(DEVICES_NS)
  ctx.effect(() => ctx.locale.register(PIN_NS, { en: pinEn, zh: pinZh }), 'delo-pin: lock screen dictionaries')
  // One function for the plugin's lifetime: the section's requests restart when its identity changes.
  const browserFetch: HostFetch = (input, init) => globalThis.fetch(input, init)
  const pin = applyPin(ctx, browserFetch, (ctx.get('connection') as ConnectionHandle).isLoopback)
  const unlock = applyUnlock(ctx, browserFetch, (ctx.get('connection') as ConnectionHandle).isLoopback, pin)
  // The unlock banner follows the page's PIN unlock: read the elevation again when the page unlocks or locks.
  let pinPhase = pin.hooks.pin.getSnapshot().phase
  ctx.effect(() => pin.hooks.pin.subscribe(() => {
    const phase = pin.hooks.pin.getSnapshot().phase
    if (phase !== pinPhase) void unlock.refresh()
    pinPhase = phase
  }), 'delo-pin: the unlock banner reads the elevation again when the page unlocks or locks')
  const pairing = createPairingSource(browserFetch)
  const pairingWriter = new PairingWriter(ctx.configForms.get<PairingRowSettings>(HOME_AUTH_ROW))
  const devicesFace = (): DevicesSectionInjected => ({
    fetch: browserFetch,
    hooks: { unlock: unlock.hooks.unlock, pairing: pairing.hooks.pairing, pairingForm: pairingWriter.form, pairingMutation: pairingWriter.state },
    openUnlock: unlock.open,
    lockUnlock: unlock.lock,
    startPairing: pairing.start,
    setPairing: (field, value) => pairingWriter.set(field, value),
    openPairingCode: pairing.openCode,
    declinePairing: pairing.decline,
  })
  if ((ctx.get('connection') as ConnectionHandle).isLoopback) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: PAIRING_NOTICE_ID,
      locale: DEVICES_NS,
      inject: (): PairingNoticeInjected => pairing,
    }, PairingNotice))
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: DEVICES_SECTION_ID,
    order: DEVICES_SECTION_ORDER,
    label: () => devicesT('nav'),
    locale: DEVICES_NS,
    inject: devicesFace,
  }, DevicesSection))
  ctx.effect(() => ctx.locale.register(NETWORK_NS, { en: networkEn, zh: networkZh }), 'delo-network: section dictionaries')
  const networkT = ctx.locale.bind(NETWORK_NS)
  const networkFace = (): NetworkSectionInjected => ({ fetch: browserFetch })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NETWORK_SECTION_ID,
    order: NETWORK_SECTION_ORDER,
    label: () => networkT('nav'),
    locale: NETWORK_NS,
    inject: networkFace,
  }, NetworkSection))
  ctx.effect(() => ctx.locale.register(VERSIONS_NS, { en: versionsEn, zh: versionsZh }), 'delo-setup-versions: section dictionaries')
  const versionsT = ctx.locale.bind(VERSIONS_NS)
  const isLoopback = (ctx.get('connection') as ConnectionHandle).isLoopback
  const versionsFace = (): VersionsSectionInjected => ({ fetch: browserFetch, atComputer: () => isLoopback })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SETUP_VERSIONS_SECTION_ID,
    order: SETUP_VERSIONS_SECTION_ORDER,
    label: () => versionsT('nav'),
    locale: VERSIONS_NS,
    inject: versionsFace,
  }, VersionsSection))
  // A link glyph stands in for a device glyph, which the icon library lacks; without this Settings draws the generic gear.
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: DEVICES_SECTION_ID }, IconLinkOutlineMedium))
  applyRemoteNotice(ctx)
  applyTrustBadge(ctx, trustApi(browserFetch))
  applyConsents(ctx, browserFetch)
}

/**
 * The chat's permission preset as its permission projection reports it.
 * @param ctx - the browser plugin context.
 * @param sessionId - the chat.
 * @returns the preset, or undefined while the chat is not materialized or has no permission control.
 */
function presetOf(ctx: Context, sessionId: SessionId): string | undefined {
  return (ctx.sessions.binding(sessionId)?.session.projections.faceOf('permissions').getSnapshot() as PermissionSelection | undefined)?.currentValue
}

/**
 * Switch a live chat's permission preset as the composer does, so the switch is logged and announced as any other, then
 * confirm that the chat's permission reports the preset.
 * @param live - the chat's session, or undefined while the chat is not materialized.
 * @param currentPreset - reads the chat's permission preset; called after the command.
 * @param preset - the preset.
 * @throws {ChatSwitchRefused} with the host's sentence when the switch is refused, or with a sentence saying the chat's
 * permission did not change.
 */
export async function switchChat(live: Pick<ISession, 'command'> | undefined, currentPreset: () => string | undefined, preset: string): Promise<void> {
  if (live === undefined) throw new ChatSwitchRefused('this session is not materialised yet')
  const result = await live.command(`/permission ${preset}`)
  if (!result.ok) throw new ChatSwitchRefused(result.error.message)
  if (!result.value.matched) throw new ChatSwitchRefused('the host offers no /permission command')
  // `command` reports whether a line matched, not whether it applied: an unknown preset answers with an error the result omits.
  if (currentPreset() !== preset) throw new ChatSwitchRefused('the chat\'s permission did not change')
}

/**
 * Register the trust badge at the sidebar's foot and read its bill while the plugin lives. A page a reach listener
 * served, a remote session, shows the bill without Check now, which the Host refuses to any Peer but the owner.
 * @param ctx - the browser plugin context.
 * @param api - the Host's trust routes.
 */
export function applyTrustBadge(ctx: Context, api: TrustApi): void {
  ctx.effect(() => ctx.locale.register(TRUST_NS, { en: trustEn, zh: trustZh }), 'delo-trust: badge dictionaries')
  const store = new TrustStore(api)
  ctx.effect(() => store.start(listener => ctx.on('connection/reset', listener)), 'delo-trust: bill reads')
  const remote = (ctx.get('connection') as ConnectionHandle | undefined)?.remoteMedia === 'placeholder'
  const face: TrustBadgeInjected = {
    hooks: { bill: store.bill, checking: store.checking },
    check: remote ? null : () => { void store.check() },
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: TRUST_BADGE.id,
    order: TRUST_BADGE.order,
    locale: TRUST_NS,
    inject: () => face,
  }, TrustBadge))
}

/**
 * Register the consent surfaces: the full-access consent behind upstream's `permissionSwitchConsent` service and its
 * `shell.overlay` entry, the approval card's full-access action, the MCP server review and the notice that a server
 * waits, and the Permissions and External agents sections.
 * @param ctx - the browser plugin context.
 * @param fetch - the request function every surface sends through.
 */
export function applyConsents(ctx: Context, fetch: HostFetch): void {
  ctx.effect(() => ctx.locale.register(CONSENTS_NS, { en: consentsEn, zh: consentsZh }), 'delo-consents: dictionaries')
  const t = ctx.locale.bind(CONSENTS_NS)
  const consent = createFullAccessConsentSource(fetch)
  ctx.provide('permissionSwitchConsent', {
    confirm: (sessionId, preset) => confirmPermissionSwitch(fetch, consent, sessionId, preset),
    ownsConfirmation: ownsPermissionConfirmation,
  } satisfies PermissionSwitchConsent)
  ctx.effect(() => () => { consent.cancel() }, 'delo-consents: an open consent answers no once the plugin unloads')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: FULL_ACCESS_CONSENT_ID,
    locale: CONSENTS_NS,
    inject: () => ({ hooks: consent.hooks, confirm: consent.confirm, cancel: consent.cancel }),
  }, FullAccessConsent))
  const review = createMcpReviewSource(fetch)
  ctx.effect(() => () => { review.cancel() }, 'delo-consents: an open MCP review answers no once the plugin unloads')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: MCP_REVIEW_ID,
    locale: CONSENTS_NS,
    inject: () => ({ hooks: review.hooks, confirm: review.confirm, cancel: review.cancel }),
  }, McpServerReview))
  const toast = createConsentToastSource()
  const noticeFace = (): McpWaitingNoticeInjected => ({ fetch, review: review.ask, notify: toast.show })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: MCP_WAITING_NOTICE_ID,
    locale: CONSENTS_NS,
    inject: noticeFace,
  }, McpWaitingNotice))
  ctx.slots.inject('conversation.approval.action', () => ctx.slots.register({
    name: 'conversation.approval.action',
    id: FULL_ACCESS_ACTION_ID,
    locale: CONSENTS_NS,
    inject: (sessionId): FullAccessActionInjected => ({ sessionId, fetch }),
  }, FullAccessAction))
  ctx.slots.inject('conversation.approval.choice', () => ctx.slots.register({
    name: 'conversation.approval.choice',
    id: ALLOW_FOR_CHAT_ID,
    locale: CONSENTS_NS,
    inject: (chat: string): AllowForChatInjected => {
      const sessionId = chat as SessionId
      const currentPreset = (): string | undefined => presetOf(ctx, sessionId)
      return {
        sessionId,
        fetch,
        consent,
        currentPreset,
        switchTo: (preset) => switchChat(ctx.sessions.binding(sessionId)?.session, currentPreset, preset),
      }
    },
  }, AllowForChat))
  ctx.slots.inject('conversation.approval.action', () => ctx.slots.register({
    name: 'conversation.approval.action',
    id: EXTERNAL_AGENT_ACTION_ID,
    locale: CONSENTS_NS,
    inject: (sessionId): ExternalAgentActionInjected => ({ sessionId, fetch }),
  }, ExternalAgentAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: CONSENT_TOAST_ID,
    locale: CONSENTS_NS,
    inject: () => ({ hooks: toast.hooks, dismiss: toast.dismiss }),
  }, ConsentToast))
  const agentSettings = new OptIn(ctx.configForms.get<DelegationConsentSettings>(DELEGATION_CONSENT_ROW))
  const permissionsFace = (): PermissionsSectionInjected => ({ fetch, ask: consent.ask, review: review.ask })
  const externalAgentsFace = (): ExternalAgentsSectionInjected => ({
    fetch,
    hooks: { agentSettings: agentSettings.form, agentSettingsMutation: agentSettings.state },
    setAgentSetting: (field, value) => agentSettings.set(field, value),
  })
  ctx.inject(['settingsShell'], (shelled) => {
    shelled.slots.inject('sidebar.brand.badge', () => shelled.slots.register({
      name: 'sidebar.brand.badge',
      locale: CONSENTS_NS,
      inject: (): DangerousBadgeInjected => ({ fetch, open: () => { shelled.settingsShell.openSection(PERMISSIONS_SECTION_ID) } }),
    }, DangerousBadge))
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PERMISSIONS_SECTION_ID,
    order: PERMISSIONS_SECTION_ORDER,
    label: () => t('permissions.nav'),
    locale: CONSENTS_NS,
    inject: permissionsFace,
  }, PermissionsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: EXTERNAL_AGENTS_SECTION_ID,
    order: EXTERNAL_AGENTS_SECTION_ORDER,
    label: () => t('agents.nav'),
    locale: CONSENTS_NS,
    inject: externalAgentsFace,
  }, ExternalAgentsSection))
}

/**
 * Register the remote studio's unlock: its store, which reads this device's unlock now, after each connection reset and
 * after each call remote access refused with `elevation-required:`, and its `shell.overlay` entry. On the home's own
 * computer the store reads nothing and the entry renders nothing.
 * @param ctx - the browser plugin context.
 * @param fetch - the request function.
 * @param onComputer - whether the page is on the home's own computer ({@link createUnlockSource}).
 * @returns the store, which the Devices section reads too.
 */
export function applyUnlock(ctx: Context, fetch: HostFetch, onComputer = false, pin?: PinSource): UnlockSource {
  const unlock = createUnlockSource(fetch, Date.now, onComputer)
  // Lock now ends the page's PIN unlock when it holds one, and the device's elevation otherwise.
  const lock = async (): Promise<void> => {
    if (pin?.holdsUnlock() === true) await pin.lock()
    else await unlock.lock()
  }
  ctx.effect(() => () => { unlock.dispose() }, 'delo-devices: the unlock\'s timers stop once the plugin unloads')
  ctx.on('remote/call-denied', (denial) => { unlock.refused(denial.reason) })
  ctx.on('connection/reset', () => { void unlock.refresh() })
  void unlock.refresh()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: UNLOCK_OVERLAY_ID,
    locale: DEVICES_NS,
    inject: () => ({ hooks: unlock.hooks, request: unlock.request, cancel: unlock.cancel, lock, dismissEnded: unlock.dismissEnded }),
  }, UnlockOverlay))
  return unlock
}

/**
 * Register PIN mode's lock screen: its store, the page events that keep the unlock alive or lock it, and its
 * `shell.overlay` entry. Where PIN mode does not apply the store settles on `off` and the entry renders nothing.
 * @param ctx - the browser plugin context.
 * @param fetch - the request function.
 * @param onComputer - whether the page is on the home's own computer ({@link createPinSource}).
 * @returns the store, which the unlock banner's Lock now reads too.
 */
export function applyPin(ctx: Context, fetch: HostFetch, onComputer = false): PinSource {
  const pin = createPinSource(fetch, Date.now, onComputer)
  ctx.effect(() => pin.dispose, 'delo-pin: the lock\'s timers stop once the plugin unloads')
  ctx.effect(() => attachPinTriggers(pin), 'delo-pin: input, visibility and page events keep the unlock alive or lock it')
  ctx.on('connection/reset', () => { void pin.refresh() })
  void pin.refresh()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: PIN_LOCK_OVERLAY_ID,
    locale: PIN_NS,
    inject: () => ({ hooks: pin.hooks, unlock: pin.unlock }),
  }, PinLock))
  return pin
}

/**
 * Show the notice each time the home refuses this page's answer to a forwarded prompt with `LOOPBACK_REQUIRED`, which
 * upstream's Client Remote service reports as `remote/answer-refused`. Only a remote session's answer is refused, so a
 * loopback page never shows it.
 * @param ctx - the browser plugin context.
 */
export function applyRemoteNotice(ctx: Context): void {
  const notice = createRemoteNoticeSource()
  ctx.on('remote/answer-refused', (refusal) => { notice.show(refusal.action) })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: REMOTE_NOTICE_ID,
    locale: DEVICES_NS,
    inject: () => ({ hooks: notice.hooks, dismiss: notice.dismiss }),
  }, RemoteNotice))
}
