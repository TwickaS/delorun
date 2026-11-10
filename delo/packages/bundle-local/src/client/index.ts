/**
 * `@delo/bundle-local`'s browser half: the Privacy section in Settings, with Delo's statements and the consent
 * switches for upstream's two opt-ins, DeepSeek's session-log upload (`session-log-deepseek`) and the desktop app's
 * analytics (`product-analytics`). Each switch writes only its own row's `config.enabled` through upstream's
 * configuration form, into the active profile's `cordis.patch.yml`.
 *
 * Other surfaces open the section with `ctx.settingsShell.openSection(PRIVACY_SECTION_ID)`.
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
import { en, zh, type PrivacyLocaleKey } from './locales.ts'
import { OptIn, type OptInSettings } from './opt-in.ts'
import { PrivacySection, type OptInId, type PrivacySectionInjected } from './PrivacySection.tsx'
import { readVersions } from './versions.ts'

export type { PrivacyLocaleKey } from './locales.ts'
export type { DeloVersionRowInjected, DeloVersionRowProps } from './DeloVersionRow.tsx'
export { readVersions, VERSIONS_GLOBAL, type DeloVersions } from './versions.ts'
export type { OptInMutation, OptInSettings } from './opt-in.ts'
export type { OptInId, PrivacySectionInjected, PrivacySectionProps } from './PrivacySection.tsx'

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
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloPrivacy'

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

/** Required services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the Privacy section, the Delo sidebar brand, Delo's preview notice, `ctx.deloNotice` and, when the harness
 * printed both versions into the page, the version row that names Delo's version and the DeepSeek Harness version. All of them come from this bundle's `delo-privacy` row, which the parity composition leaves disabled,
 * so upstream's brand and notice stay in the parity composition.
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
}
