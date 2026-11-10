/**
 * `@delo/bundle-local`'s browser half: the Privacy section in Settings, with Delo's statements and the consent
 * switches for upstream's two opt-ins, DeepSeek's session-log upload (`session-log-deepseek`) and the desktop app's
 * analytics (`product-analytics`). Each switch writes only its own row's `config.enabled` through upstream's
 * configuration form, into the active profile's `cordis.patch.yml`.
 *
 * It also registers the Devices section, which shows the reach state and manages the devices the home approved, and,
 * on a remote studio page, the notice that a full-access grant must be answered at the home's own computer.
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
import { SETUP_OPT_IN_ROWS } from '@delo/contract-setup-answers'
import { DeloBrandMark, DeloBrandName } from './brand.tsx'
import { acknowledgeNotice, DeloNotice, noticeAcknowledged, type DeloNoticeInjected } from './DeloNotice.tsx'
import { DeloVersionRow, type DeloVersionRowInjected } from './DeloVersionRow.tsx'
import { en as devicesEn, zh as devicesZh, type DevicesLocaleKey } from './devices-locales.ts'
import type { HostFetch } from './devices-api.ts'
import { DevicesSection, type DevicesSectionInjected } from './DevicesSection.tsx'
import { createRemoteNoticeSource, isLoopbackHostname, RemoteNotice } from './RemoteNotice.tsx'
import { en, zh, type PrivacyLocaleKey } from './locales.ts'
import { OptIn, type OptInSettings } from './opt-in.ts'
import { PrivacySection, type OptInId, type PrivacySectionInjected } from './PrivacySection.tsx'
import { readVersions } from './versions.ts'

export type { PrivacyLocaleKey } from './locales.ts'
export type { DevicesLocaleKey } from './devices-locales.ts'
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
    /** The Devices section's copy and the remote studio's full-access notice. */
    'deloDevices': DevicesLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloPrivacy'

/** Dictionary namespace of the Devices section and the remote full-access notice. */
export const DEVICES_NS = 'deloDevices'

/** The `settings.section` id of the Privacy section, which setup and other surfaces open. */
export const PRIVACY_SECTION_ID = 'delo-privacy'

/** The section's place in the Settings navigation: after upstream's Plugins section (15). */
export const PRIVACY_SECTION_ORDER = 20

/** The Host row each opt-in writes, from C11's answer-to-row mapping. */
export const OPT_IN_ROWS: Readonly<Record<OptInId, string>> = {
  sessionLog: SETUP_OPT_IN_ROWS.sessionLogUpload,
  analytics: SETUP_OPT_IN_ROWS.desktopAnalytics,
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

/** The `shell.overlay` id of the remote studio's full-access notice. */
export const REMOTE_NOTICE_ID = 'delo-remote-full-access'

/** Required services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the Privacy and Devices sections, the Delo sidebar brand, Delo's preview notice, `ctx.deloNotice`, on a
 * remote page the full-access notice, and, when the harness printed both versions into the page, the version row that
 * names Delo's version and the DeepSeek Harness version. All of them come from this bundle's `delo-privacy` row, which
 * the parity composition leaves disabled, so upstream's brand and notice stay in the parity composition.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.provide('deloNotice', { acknowledged: () => noticeAcknowledged(), acknowledge: () => { acknowledgeNotice() } } satisfies DeloNoticeService)
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
  applyRemoteNotice(ctx, globalThis.location.hostname)
}

/**
 * On a remote studio page, show the full-access notice after this page answers `allowed-once` to a prompt whose
 * answer grants full access, which the home refuses from a remote session. The listener wraps the answerers after it
 * in the `approval/request` waterfall and returns their answer unchanged; it sees the answer only while it runs before
 * the answerer that gives it. On a loopback page it registers nothing.
 * @param ctx - the browser plugin context.
 * @param hostname - the page's `location.hostname`.
 */
export function applyRemoteNotice(ctx: Context, hostname: string): void {
  if (isLoopbackHostname(hostname)) return
  const notice = createRemoteNoticeSource()
  ctx.inject(['remote'], (scope) => {
    scope.remote.$on('approval/request', async function (request, next) {
      const answer = await next()
      if (request.grants === 'full-access' && answer === 'allowed-once') notice.show()
      return answer
    })
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: REMOTE_NOTICE_ID,
    locale: DEVICES_NS,
    inject: () => ({ hooks: notice.hooks, dismiss: notice.dismiss }),
  }, RemoteNotice))
}
