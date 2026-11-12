/**
 * `@delo/bundle-local`'s browser half: the Privacy section in Settings, with Delo's statements, the consent
 * switches for upstream's two opt-ins, DeepSeek's session-log upload (`session-log-deepseek`) and the desktop app's
 * analytics (`product-analytics`), and the switch of Delo's release check (`delo-update-check`). Each switch writes
 * only its own row's `config.enabled` through upstream's configuration form, into the active profile's
 * `cordis.patch.yml`.
 *
 * It also registers the Devices section, which shows the reach state and manages the devices the home approved, and
 * the notice that an answer the home refused, such as a full-access grant from a remote studio, must be given at the
 * home's own computer. The consent surfaces of Delo's two consent plugins come from here too: the full-access consent,
 * which upstream's permission control asks through the `permissionSwitchConsent` service before a chat switches to
 * full access in a workspace without a grant; the approval card's action for a request that asks for full access; the
 * review of a waiting stdio MCP server and the notice that one waits; and the Permissions section, which lists every
 * full-access grant and every waiting or allowed MCP server with a one-click revoke. Each reads its plugin's routes,
 * which answer only the home's own computer, but for the waiting servers' names, and are absent while the plugin's
 * switch is off.
 *
 * Other surfaces open the sections with `ctx.settingsShell.openSection(PRIVACY_SECTION_ID)` or
 * `ctx.settingsShell.openSection(DEVICES_SECTION_ID)`.
 * @module @delo/bundle-local/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'settings.section' SlotMap entry and the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the 'sidebar.brand.mark' and 'sidebar.brand.name' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SETUP_OPT_IN_ROWS, SETUP_UPDATE_CHECK_ROW } from '@delo/contract-setup-answers'
import { DeloBrandMark, DeloBrandName } from './brand.tsx'
import { acknowledgeNotice, DeloNotice, noticeAcknowledged, type DeloNoticeInjected } from './DeloNotice.tsx'
import { DeloVersionRow, type DeloVersionRowInjected } from './DeloVersionRow.tsx'
import { en as devicesEn, zh as devicesZh, type DevicesLocaleKey } from './devices-locales.ts'
import type { HostFetch } from './devices-api.ts'
import { DevicesSection, type DevicesSectionInjected } from './DevicesSection.tsx'
import { en, zh, type PrivacyLocaleKey } from './locales.ts'
import { OptIn, type OptInSettings } from './opt-in.ts'
import { PrivacySection, type OptInId, type PrivacySectionInjected } from './PrivacySection.tsx'
import { overrideTitle } from './title.ts'
import { readVersions } from './versions.ts'
import { createRemoteNoticeSource, RemoteNotice } from './RemoteNotice.tsx'
// Type-only: the ctx.permissionSwitchConsent merge.
import type { PermissionSwitchConsent } from '@deepseek-ai/dsh-client-ui-permission-presets/client'
// Type-only: the 'conversation.approval.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import { en as consentsEn, zh as consentsZh, type ConsentsLocaleKey } from './consents-locales.ts'
import { ConsentToast, createConsentToastSource } from './ConsentToast.tsx'
import { FullAccessAction, type FullAccessActionInjected } from './FullAccessAction.tsx'
import { ExternalAgentAction, type ExternalAgentActionInjected } from './ExternalAgentAction.tsx'
import { confirmPermissionSwitch, createFullAccessConsentSource, FullAccessConsent } from './FullAccessConsent.tsx'
import { createMcpReviewSource, McpServerReview } from './McpServerReview.tsx'
import { McpWaitingNotice, type McpWaitingNoticeInjected } from './McpWaitingNotice.tsx'
import { PermissionsSection, type PermissionsSectionInjected } from './PermissionsSection.tsx'

export type { PrivacyLocaleKey } from './locales.ts'
export type { DevicesLocaleKey } from './devices-locales.ts'
export type { ConsentsLocaleKey } from './consents-locales.ts'
export type { PermissionsSectionInjected, PermissionsSectionProps } from './PermissionsSection.tsx'
export type { FullAccessConsentProps, FullAccessConsentSource, FullAccessConsentState } from './FullAccessConsent.tsx'
export type { FullAccessActionInjected, FullAccessActionProps } from './FullAccessAction.tsx'
export type { ExternalAgentActionInjected, ExternalAgentActionProps } from './ExternalAgentAction.tsx'
export type { McpReviewSource, McpReviewState, McpServerReviewProps } from './McpServerReview.tsx'
export type { McpWaitingNoticeInjected, McpWaitingNoticeProps } from './McpWaitingNotice.tsx'
export type { ConsentToastProps, ConsentToastSource, ConsentToastState } from './ConsentToast.tsx'
export type { DeloVersionRowInjected, DeloVersionRowProps } from './DeloVersionRow.tsx'
export { readVersions, VERSIONS_GLOBAL, type DeloVersions } from './versions.ts'
export type { OptInMutation, OptInSettings } from './opt-in.ts'
export type { OptInId, PrivacySectionInjected, PrivacySectionProps } from './PrivacySection.tsx'
export type { DevicesSectionInjected, DevicesSectionProps } from './DevicesSection.tsx'
export {
  DEVICE_ROUTES, HostRequestError, readReachStatus, REACH_STATES,
  type HostFailure, type HostFetch, type ReachOptionStatus, type ReachState, type ReachStatus,
} from './devices-api.ts'

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
    /** The Privacy section's copy. */
    'deloPrivacy': PrivacyLocaleKey
    /** The Devices section's copy and the remote studio's refused-answer notice. */
    'deloDevices': DevicesLocaleKey
    /** The full-access consent, the approval card's action, the MCP server review and notice, and the Permissions section. */
    'deloConsents': ConsentsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloPrivacy'

/** Dictionary namespace of the Devices section and the remote refused-answer notice. */
export const DEVICES_NS = 'deloDevices'

/** The `settings.section` id of the Privacy section, which setup and other surfaces open. */
export const PRIVACY_SECTION_ID = 'delo-privacy'

/** The section's place in the Settings navigation: after upstream's Plugins section (15). */
export const PRIVACY_SECTION_ORDER = 20

/** The row of Delo's release check, whose `enabled` is C16 switch `update_check`; setup's `updateCheck` answer writes the same field. */
export const UPDATE_CHECK_ROW = SETUP_UPDATE_CHECK_ROW

/** The Host row each switch writes: the opt-ins and the release check from C11's answer-to-row mapping. */
export const OPT_IN_ROWS: Readonly<Record<OptInId, string>> = {
  sessionLog: SETUP_OPT_IN_ROWS.sessionLogUpload,
  analytics: SETUP_OPT_IN_ROWS.desktopAnalytics,
  updateCheck: UPDATE_CHECK_ROW,
}

/**
 * The version row's id and rank: the stock row's id at a lower shadowing rank, so it renders in that row's place and
 * keeps its place in grouped Settings.
 */
export const VERSION_ROW = { id: 'current-version', priority: -1 } as const

/** The `settings.section` id of the Devices section, which onboarding and other surfaces open. */
export const DEVICES_SECTION_ID = 'delo-devices'

/** The Devices section's place in the Settings navigation: right after Privacy. */
export const DEVICES_SECTION_ORDER = 21

/** The `shell.overlay` id of the remote studio's refused-answer notice. */
export const REMOTE_NOTICE_ID = 'delo-remote-full-access'

/** Dictionary namespace of the consent surfaces. */
export const CONSENTS_NS = 'deloConsents'

/** The `settings.section` id of the Permissions section. */
export const PERMISSIONS_SECTION_ID = 'delo-permissions'

/** The Permissions section's place in the Settings navigation: right after Devices. */
export const PERMISSIONS_SECTION_ORDER = 22

/** The `shell.overlay` id of the full-access consent. */
export const FULL_ACCESS_CONSENT_ID = 'delo-full-access-consent'

/** The `shell.overlay` id of the MCP server review. */
export const MCP_REVIEW_ID = 'delo-mcp-review'

/** The `shell.overlay` id of the notice that an MCP server waits. */
export const MCP_WAITING_NOTICE_ID = 'delo-mcp-waiting'

/** The `shell.overlay` id of the toast that shows the outcome of an answer given outside Settings. */
export const CONSENT_TOAST_ID = 'delo-consents-toast'

/** The `conversation.approval.action` id of the full-access action. */
export const FULL_ACCESS_ACTION_ID = 'delo-full-access'

/** The `conversation.approval.action` id of the external-agent action. */
export const EXTERNAL_AGENT_ACTION_ID = 'delo-external-agent'

/** Required services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the Privacy and Devices sections, the Delo sidebar brand, the product name as the document title, Delo's
 * preview notice, `ctx.deloNotice`, the refused-answer notice, and, when the harness printed both versions into the
 * page, the version row that names Delo's version and the DeepSeek Harness version. All of them come from this bundle's
 * `delo-privacy` row, which the parity composition leaves disabled, so upstream's brand, title and notice stay in the
 * parity composition.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.provide('deloNotice', { acknowledged: () => noticeAcknowledged(), acknowledge: () => { acknowledgeNotice() } } satisfies DeloNoticeService)
  ctx.effect(() => overrideTitle(ctx.locale), 'delo-privacy: the product name as the document title')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DeloBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, DeloBrandName)
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
  }
  const face = (): PrivacySectionInjected => ({
    hooks: {
      sessionLog: optIns.sessionLog.form,
      sessionLogMutation: optIns.sessionLog.state,
      analytics: optIns.analytics.form,
      analyticsMutation: optIns.analytics.state,
      updateCheck: optIns.updateCheck.form,
      updateCheckMutation: optIns.updateCheck.state,
    },
    setEnabled: (id, enabled) => optIns[id].setEnabled(enabled),
  })
  const versions = readVersions()
  if (versions !== undefined) {
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: VERSION_ROW.id,
      priority: VERSION_ROW.priority,
      inject: (): DeloVersionRowInjected => ({ versions, t: (key, params) => t(key, params) }),
    }, DeloVersionRow))
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PRIVACY_SECTION_ID,
    order: PRIVACY_SECTION_ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: face,
  }, PrivacySection))
  ctx.effect(() => ctx.locale.register(DEVICES_NS, { en: devicesEn, zh: devicesZh }), 'delo-devices: section dictionaries')
  const devicesT = ctx.locale.bind(DEVICES_NS)
  // One function for the plugin's lifetime: the section's requests restart when its identity changes.
  const browserFetch: HostFetch = (input, init) => globalThis.fetch(input, init)
  const devicesFace = (): DevicesSectionInjected => ({ fetch: browserFetch })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: DEVICES_SECTION_ID,
    order: DEVICES_SECTION_ORDER,
    label: () => devicesT('nav'),
    locale: DEVICES_NS,
    inject: devicesFace,
  }, DevicesSection))
  applyRemoteNotice(ctx)
  applyConsents(ctx, browserFetch)
}

/**
 * Register the consent surfaces: the full-access consent behind upstream's `permissionSwitchConsent` service and its
 * `shell.overlay` entry, the approval card's full-access action, the MCP server review and the notice that a server
 * waits, and the Permissions section.
 * @param ctx - the browser plugin context.
 * @param fetch - the request function every surface sends through.
 */
export function applyConsents(ctx: Context, fetch: HostFetch): void {
  ctx.effect(() => ctx.locale.register(CONSENTS_NS, { en: consentsEn, zh: consentsZh }), 'delo-consents: dictionaries')
  const t = ctx.locale.bind(CONSENTS_NS)
  const consent = createFullAccessConsentSource(fetch)
  ctx.provide('permissionSwitchConsent', {
    confirm: (sessionId, preset) => confirmPermissionSwitch(fetch, consent, sessionId, preset),
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
    inject: (sessionId): FullAccessActionInjected => ({ sessionId, fetch, ask: consent.ask }),
  }, FullAccessAction))
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
  const permissionsFace = (): PermissionsSectionInjected => ({ fetch, ask: consent.ask, review: review.ask })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PERMISSIONS_SECTION_ID,
    order: PERMISSIONS_SECTION_ORDER,
    label: () => t('permissions.nav'),
    locale: CONSENTS_NS,
    inject: permissionsFace,
  }, PermissionsSection))
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
