// @vitest-environment jsdom
/** The Privacy section turns each upstream opt-in on only after consent, alone, and off again from the same screen. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject, type ConfigForm, type ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, OPT_IN_ROWS, PRIVACY_SECTION_ID, PRIVACY_SECTION_ORDER } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { OptIn, type OptInSettings } from '../src/client/opt-in.ts'
import { PrivacySection, type OptInId, type PrivacySectionProps } from '../src/client/PrivacySection.tsx'
import { apply as hostApply } from '../src/index.ts'
import { NOTICE_STORAGE_KEY, NOTICE_VERSION } from '../src/client/DeloNotice.tsx'

afterEach(cleanup)

/** One opt-in's Host form, accepting each write as the Host would. */
function hostForm(status: ConfigFormSnapshot<OptInSettings>['status'] = 'ready') {
  const state = createSnapshotStore<ConfigFormSnapshot<OptInSettings>>({
    status, value: status === 'ready' ? { enabled: false } : undefined, base: {}, user: {}, revision: 0, writable: true,
  })
  const set = vi.fn(async (_field: string, value: unknown) => {
    state.update((draft) => { draft.value = { enabled: value === true } })
    return true
  })
  const form: ConfigForm<OptInSettings> = {
    getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener),
    set, unset: vi.fn(), mutate: vi.fn(),
  }
  return { form, set, optIn: new OptIn(form) }
}

function renderSection(analyticsStatus: ConfigFormSnapshot<OptInSettings>['status'] = 'ready') {
  const forms = { sessionLog: hostForm(), analytics: hostForm(analyticsStatus) }
  // The renderer's standard props are absent: the section reads none of them.
  const props = {
    t: makeTranslate(en),
    close: () => {},
    useSessionLog: bindSnapshotSelector(forms.sessionLog.form),
    useSessionLogMutation: bindSnapshotSelector(forms.sessionLog.optIn.state),
    useAnalytics: bindSnapshotSelector(forms.analytics.form),
    useAnalyticsMutation: bindSnapshotSelector(forms.analytics.optIn.state),
    setEnabled: (id: OptInId, enabled: boolean) => forms[id].optIn.setEnabled(enabled),
  } as PrivacySectionProps
  render(<PrivacySection {...props} />)
  return forms
}

const switchOf = (name: string): HTMLElement => screen.getByRole('switch', { name })

describe('the Privacy section', () => {
  it('states that Delo has no telemetry and shows both opt-ins off', () => {
    renderSection()
    for (const key of ['statement.delo', 'statement.optIns', 'statement.feedback'] as const) expect(screen.getByText(en[key])).toBeTruthy()
    expect(switchOf(en['sessionLog.title']).getAttribute('aria-checked')).toBe('false')
    expect(switchOf(en['analytics.title']).getAttribute('aria-checked')).toBe('false')
  })

  it.each([
    { id: 'sessionLog', other: 'analytics' },
    { id: 'analytics', other: 'sessionLog' },
  ] as const)('turns $id on alone after consent and off again from the same screen', async ({ id, other }) => {
    const forms = renderSection()
    const toggle = switchOf(en[`${id}.title`])
    fireEvent.click(toggle)
    // Cancelling the consent dialog writes nothing.
    let dialog = screen.getByRole('dialog', { name: en[`${id}.confirm.title`] })
    expect(within(dialog).getByText(en[`${id}.confirm.body`])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(forms[id].set).not.toHaveBeenCalled()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    dialog = screen.getByRole('dialog', { name: en[`${id}.confirm.title`] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
    expect(forms[id].set.mock.calls).toEqual([['enabled', true]])
    expect(forms[other].set).not.toHaveBeenCalled()
    expect(switchOf(en[`${other}.title`]).getAttribute('aria-checked')).toBe('false')
    // Turning it off asks nothing.
    fireEvent.click(toggle)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(forms[id].set.mock.calls).toEqual([['enabled', true], ['enabled', false]])
    expect(forms[other].set).not.toHaveBeenCalled()
  })

  it('says why desktop analytics has no switch in a profile that does not serve it', () => {
    renderSection('unavailable')
    expect(screen.getByText(en['analytics.unavailable'])).toBeTruthy()
    expect(screen.queryByRole('switch', { name: en['analytics.title'] })).toBeNull()
    expect(switchOf(en['sessionLog.title'])).toBeTruthy()
  })

  it.each(['refused', 'rejected'] as const)('keeps the accepted value and says so after a %s write', async (failure) => {
    const forms = renderSection()
    if (failure === 'refused') forms.sessionLog.set.mockResolvedValue(false)
    else forms.sessionLog.set.mockRejectedValue(new Error('Disconnected'))
    fireEvent.click(switchOf(en['sessionLog.title']))
    fireEvent.click(screen.getByRole('button', { name: en['confirm.accept'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    expect(switchOf(en['sessionLog.title']).getAttribute('aria-checked')).toBe('false')
  })

  it('has a Chinese entry for every English key', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('the plugin', () => {
  it('registers the section and writes each opt-in to its own upstream row', async () => {
    expect(hostApply).not.toThrow()
    expect(OPT_IN_ROWS).toEqual({ sessionLog: 'session-log-deepseek', analytics: 'product-analytics' })
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      const describeSettings = vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } }))
      new TestRemote(ctx, { settings: { describe: describeSettings } })
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('no slot registry')
      // The Settings shell declares the section slot; this stands in for it.
      // The sidebar's brand holes are declared at the root, where the Delo occupants wait for them.
      slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('settings.section', { close: () => {} })}</>)
      await ctx.plugin({ inject, apply }).await()
      const [section] = slots.entries('settings.section')
      expect(section?.options).toMatchObject({ id: PRIVACY_SECTION_ID, order: PRIVACY_SECTION_ORDER })
      expect(slots.entries('sidebar.brand.name')).toHaveLength(1)
      expect(slots.entries('sidebar.brand.mark')).toHaveLength(1)
      const sessionLog = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.sessionLog), 'set').mockResolvedValue(true)
      const analytics = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.analytics), 'set').mockResolvedValue(true)
      const face = section?.inject?.()
      if (face === undefined || !('setEnabled' in face) || typeof face.setEnabled !== 'function') throw new Error('no section face')
      await face.setEnabled('analytics', true)
      expect(analytics).toHaveBeenCalledWith('enabled', true)
      expect(sessionLog).not.toHaveBeenCalled()
      await face.setEnabled('sessionLog', false)
      expect(sessionLog).toHaveBeenCalledWith('enabled', false)
      // ctx.deloNotice records the notice's acknowledgement for a flow that shows its copy itself.
      const notice = ctx.get('deloNotice')
      if (notice === undefined) throw new Error('no deloNotice service')
      globalThis.localStorage.clear()
      expect(notice.acknowledged()).toBe(false)
      notice.acknowledge()
      expect(notice.acknowledged()).toBe(true)
      expect(globalThis.localStorage.getItem(NOTICE_STORAGE_KEY)).toBe(NOTICE_VERSION)
      globalThis.localStorage.clear()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
