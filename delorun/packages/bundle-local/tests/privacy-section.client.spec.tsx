// @vitest-environment jsdom
/**
 * The Privacy section and the release check's General row turn each switch on only after consent, alone, and off again
 * from the same screen; the plugin registers them, the versions row and the About section.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { apply as connectionApply } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, makeTranslate, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { COMMON_NS, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject, type ConfigForm, type ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsLayoutRegistry, type SettingsLayout } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import {
  ABOUT_SECTION_ID, ABOUT_SECTION_ORDER, apply, inject, OPT_IN_ROWS, PLUGIN_INSTALLS_SECTION_ID, PLUGIN_INSTALLS_SECTION_ORDER, PRIVACY_SECTION_ID, PRIVACY_SECTION_ORDER, UPDATE_CHECK_ITEM,
  VERSION_ROW, VERSIONS_GLOBAL, VERSIONS_ITEM,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { OptIn, type OptInField, type OptInSettings } from '../src/client/opt-in.ts'
import { PluginInstallsSection, type PluginInstallsSectionProps } from '../src/client/PluginInstallsSection.tsx'
import { PrivacySection, type PrivacyOptInId, type PrivacySectionProps } from '../src/client/PrivacySection.tsx'
import { UpdateCheckRow, type UpdateCheckRowProps } from '../src/client/UpdateCheckRow.tsx'
import { NOTICE_STORAGE_KEY, NOTICE_VERSION } from '../src/client/DelorunNotice.tsx'
import { TITLE_KEY } from '../src/client/title.ts'

afterEach(cleanup)

/** One switch's Host form, accepting each write of its field as the Host would. */
function hostForm(status: ConfigFormSnapshot<OptInSettings>['status'] = 'ready', enabled = false, field: OptInField = 'enabled') {
  const state = createSnapshotStore<ConfigFormSnapshot<OptInSettings>>({
    status, value: status === 'ready' ? { [field]: enabled } : undefined, base: {}, user: {}, revision: 0, writable: true,
  })
  const set = vi.fn(async (written: string, value: unknown) => {
    state.update((draft) => { draft.value = { [written]: value === true } })
    return true
  })
  const form: ConfigForm<OptInSettings> = {
    getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener),
    set, unset: vi.fn(), mutate: vi.fn(),
  }
  return { form, set, optIn: new OptIn(form, field) }
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
    setEnabled: (id: PrivacyOptInId, enabled: boolean) => forms[id].optIn.setEnabled(enabled),
  } as PrivacySectionProps
  render(<PrivacySection {...props} />)
  return forms
}

function renderInstalls(status: ConfigFormSnapshot<OptInSettings>['status'] = 'ready') {
  const npmMirror = hostForm(status, false, 'npmMirror')
  // The renderer's standard props are absent: the section reads none of them.
  const props = {
    t: makeTranslate(en),
    useNpmMirror: bindSnapshotSelector(npmMirror.form),
    useNpmMirrorMutation: bindSnapshotSelector(npmMirror.optIn.state),
    setEnabled: (value: boolean) => npmMirror.optIn.setEnabled(value),
  } as PluginInstallsSectionProps
  const view = render(<PluginInstallsSection {...props} />)
  return { npmMirror, view }
}

function renderUpdateCheck(status: ConfigFormSnapshot<OptInSettings>['status'] = 'ready', enabled = true) {
  const updateCheck = hostForm(status, enabled)
  // The renderer's standard props are absent: the row reads none of them.
  const props = {
    t: makeTranslate(en),
    useUpdateCheck: bindSnapshotSelector(updateCheck.form),
    useUpdateCheckMutation: bindSnapshotSelector(updateCheck.optIn.state),
    setEnabled: (value: boolean) => updateCheck.optIn.setEnabled(value),
  } as UpdateCheckRowProps
  render(<UpdateCheckRow {...props} />)
  return updateCheck
}

const switchOf = (name: string): HTMLElement => screen.getByRole('switch', { name })

describe('the Privacy section', () => {
  it('opens with one sentence, shows the session-log opt-in off under its heading and no analytics row, states how feedback is sent, and leaves the release check to General and the npm mirror to Plugins', () => {
    renderSection()
    expect(screen.getByText(en.intro)).toBeTruthy()
    const group = screen.getByRole('region', { name: en['sharing.heading'] })
    expect(within(group).getByText(en['statement.feedback'])).toBeTruthy()
    expect(within(group).getByRole('switch', { name: en['sessionLog.title'] }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('switch', { name: en['analytics.title'] })).toBeNull()
    expect(screen.queryByText(en['analytics.unavailable'])).toBeNull()
    for (const key of ['statement.delorun', 'statement.optIns', 'statement.updateCheck', 'updateCheck.title', 'npmMirror.title'] as const) expect(screen.queryByText(en[key])).toBeNull()
    expect(screen.queryAllByRole('switch')).toHaveLength(1)
  })

  it.each([
    { id: 'sessionLog' },
  ] as const)('turns $id on alone after consent and off again from the same screen', async ({ id }) => {
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
    // Turning it off asks nothing.
    fireEvent.click(toggle)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(forms[id].set.mock.calls).toEqual([['enabled', true], ['enabled', false]])
  })

  it('turns the npm mirror on after consent by writing npmMirror of the install check\'s row, and off at once', async () => {
    const { npmMirror } = renderInstalls()
    expect(screen.getByRole('region', { name: en['installs.heading'] })).toBeTruthy()
    const toggle = switchOf(en['npmMirror.title'])
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    const dialog = screen.getByRole('dialog', { name: en['npmMirror.confirm.title'] })
    expect(within(dialog).getByText(en['npmMirror.confirm.body']).textContent).toMatch(/It applies from the next start\.$/u)
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
    fireEvent.click(toggle)
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(npmMirror.set.mock.calls).toEqual([['npmMirror', true], ['npmMirror', false]])
    expect(OPT_IN_ROWS.npmMirror).toBe('delorun-plugin-install-check')
  })

  it('shows nothing where the profile does not load the plugin install check', () => {
    const { view } = renderInstalls('unavailable')
    expect(view.container.textContent).toBe('')
  })

  it('writes a switch once while its first write is still crossing the wire', async () => {
    const { set, optIn } = hostForm()
    let release: (accepted: boolean) => void = () => {}
    set.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve }))
    const first = optIn.setEnabled(true)
    await optIn.setEnabled(false)
    expect(set.mock.calls).toEqual([['enabled', true]])
    release(true)
    await first
    expect(optIn.state.getSnapshot()).toEqual({ busy: false, failed: false })
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

describe('the release check\'s General row', () => {
  it('shows the check on by default, turns it off at once, and asks before it is on again', async () => {
    const updateCheck = renderUpdateCheck()
    const toggle = switchOf(en['updateCheck.title'])
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(en['updateCheck.description'])).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
    expect(updateCheck.set.mock.calls).toEqual([['enabled', false]])
    // Cancelling the consent dialog writes nothing.
    fireEvent.click(toggle)
    let dialog = screen.getByRole('dialog', { name: en['updateCheck.confirm.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(updateCheck.set.mock.calls).toEqual([['enabled', false]])
    fireEvent.click(toggle)
    dialog = screen.getByRole('dialog', { name: en['updateCheck.confirm.title'] })
    expect(within(dialog).getByText(en['updateCheck.confirm.body']).textContent).toMatch(/Nothing is downloaded or installed until you run delorun update\.$/)
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.accept'] }))
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
    expect(updateCheck.set.mock.calls).toEqual([['enabled', false], ['enabled', true]])
  })

  it('names the host of another release channel in the row and its consent dialog, in place of the production hosts', async () => {
    const fetched = vi.fn(async (_path: string) => new Response(JSON.stringify({ host: '127.0.0.1:18080' })))
    vi.stubGlobal('fetch', fetched)
    onTestFinished(() => { vi.unstubAllGlobals() })
    renderUpdateCheck('ready', false)
    const description = await screen.findByText(en['updateCheck.description.channel'].replace('{host}', '127.0.0.1:18080'))
    expect(description.textContent).not.toMatch(/releases\.delorun\.com|GitHub/u)
    expect(fetched.mock.calls[0]![0]).toBe('api/delorunUpdateCheck.channel')
    fireEvent.click(switchOf(en['updateCheck.title']))
    const dialog = screen.getByRole('dialog', { name: en['updateCheck.confirm.title'] })
    expect(within(dialog).getByText(en['updateCheck.confirm.body.channel'].replace('{host}', '127.0.0.1:18080'))).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/releases\.delorun\.com|GitHub/u)
  })

  it('keeps the production wording when the channel route names no host or is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ host: null }))))
    onTestFinished(() => { vi.unstubAllGlobals() })
    renderUpdateCheck('ready', false)
    await waitFor(() => { expect(screen.getByText(en['updateCheck.description'])).toBeTruthy() })
    expect(en['updateCheck.description']).toContain('releases.delorun.com and GitHub')
  })

  it('closes the consent dialog from its close button without writing', () => {
    const updateCheck = renderUpdateCheck('ready', false)
    fireEvent.click(switchOf(en['updateCheck.title']))
    const dialog = screen.getByRole('dialog', { name: en['updateCheck.confirm.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(updateCheck.set).not.toHaveBeenCalled()
  })

  it('says why there is no switch in a profile that does not serve the check', () => {
    renderUpdateCheck('unavailable')
    expect(screen.getByText(en['updateCheck.unavailable'])).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('names the General path that turns the check off', () => {
    expect(en['statement.updateCheck']).toMatch(/Turn it off in Settings → General → Updates\.$/)
    expect(zh['statement.updateCheck']).toMatch(/设置 → 通用 → 更新/)
  })
})

describe('the plugin', () => {
  it('registers the sections and the release check\'s row, and writes each opt-in to its own row', async () => {
    expect(OPT_IN_ROWS).toEqual({ sessionLog: 'session-log-deepseek', analytics: 'product-analytics', updateCheck: 'delorun-update-check', npmMirror: 'delorun-plugin-install-check' })
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', locale)
      ctx.provide('sessions', {})
      const describeSettings = vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } }))
      new TestRemote(ctx, { settings: { describe: describeSettings } })
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('no slot registry')
      // The Settings shell declares the section slot; this stands in for it.
      // The sidebar's brand holes are declared at the root, where the Delorun occupants wait for them.
      slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'settings.general.item': { kind: 'list', scope: 'root' }, 'settings.onboarding': { kind: 'list', scope: 'root' }, 'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('settings.section', { close: () => {} })}</>)
      await ctx.plugin({ inject: [], apply: connectionApply }).await()
      // Upstream's brand is already registered at the default priority when this bundle applies, as it is once the bundle also waits for `connection`.
      slots.register({ name: 'sidebar.brand.mark' }, () => null)
      slots.register({ name: 'sidebar.brand.name' }, () => null)
      await ctx.plugin({ inject, apply }).await()
      const section = slots.entries('settings.section').find(entry => entry.options.id === PRIVACY_SECTION_ID)
      const about = slots.entries('settings.section').find(entry => entry.options.id === ABOUT_SECTION_ID)
      expect(section?.options).toMatchObject({ id: PRIVACY_SECTION_ID, order: PRIVACY_SECTION_ORDER })
      const label = section?.options.label
      expect(typeof label === 'function' ? label() : label).toBe(en.nav)
      const installs = slots.entries('settings.section').find(entry => entry.options.id === PLUGIN_INSTALLS_SECTION_ID)
      expect(installs?.options).toMatchObject({ order: PLUGIN_INSTALLS_SECTION_ORDER })
      const installsLabel = installs?.options.label
      expect(typeof installsLabel === 'function' ? installsLabel() : installsLabel).toBe(en['installs.nav'])
      expect(about?.options).toMatchObject({ order: ABOUT_SECTION_ORDER })
      const aboutLabel = about?.options.label
      expect(typeof aboutLabel === 'function' ? aboutLabel() : aboutLabel).toBe(en['about.nav'])
      // The preview notice's onboarding step reads its copy from this bundle's dictionary.
      const [noticeStep] = slots.entries('settings.onboarding')
      const noticeFace = noticeStep?.inject?.()
      if (noticeFace === undefined || !('t' in noticeFace) || typeof noticeFace.t !== 'function') throw new Error('no notice face')
      expect(noticeFace.t('notice.title')).toBe(en['notice.title'])
      // Delorun's brand registers beside upstream's at a lower priority, which renders, instead of colliding with it.
      for (const slot of ['sidebar.brand.name', 'sidebar.brand.mark'] as const) {
        expect(slots.entries(slot).map(entry => entry.options.priority ?? 0).sort()).toEqual([-1, 0])
      }
      // The document title upstream's frame reads in a build without DSH_CLIENT_TITLE.
      expect(locale.bind(COMMON_NS)(TITLE_KEY)).toBe('Delorun')
      const sessionLog = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.sessionLog), 'set').mockResolvedValue(true)
      const analytics = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.analytics), 'set').mockResolvedValue(true)
      const face = section?.inject?.()
      if (face === undefined || !('setEnabled' in face) || typeof face.setEnabled !== 'function') throw new Error('no section face')
      await face.setEnabled('analytics', true)
      expect(analytics).toHaveBeenCalledWith('enabled', true)
      expect(sessionLog).not.toHaveBeenCalled()
      const mirror = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.npmMirror), 'set').mockResolvedValue(true)
      const installsFace = installs?.inject?.()
      if (installsFace === undefined || !('setEnabled' in installsFace) || typeof installsFace.setEnabled !== 'function') throw new Error('no installs face')
      await installsFace.setEnabled(true)
      expect(mirror).toHaveBeenCalledWith('npmMirror', true)
      await face.setEnabled('sessionLog', false)
      expect(sessionLog).toHaveBeenCalledWith('enabled', false)
      // The release check's General row writes the same row through its own opt-in.
      const updateCheck = vi.spyOn(ctx.configForms.get(OPT_IN_ROWS.updateCheck), 'set').mockResolvedValue(true)
      const items = slots.entries('settings.general.item')
      // No versions in the page: the stock version row stays, and no versions line shows.
      expect(items.map(item => item.options)).toMatchObject([{ id: UPDATE_CHECK_ITEM.id, order: UPDATE_CHECK_ITEM.order }])
      const rowFace = items[0]?.inject?.()
      if (rowFace === undefined || !('setEnabled' in rowFace) || typeof rowFace.setEnabled !== 'function') throw new Error('no row face')
      await rowFace.setEnabled(false)
      expect(updateCheck.mock.calls).toEqual([['enabled', false]])
      expect(analytics).toHaveBeenCalledTimes(1)
      // ctx.delorunNotice records the notice's acknowledgement for a flow that shows its copy itself.
      const notice = ctx.get('delorunNotice')
      if (notice === undefined) throw new Error('no delorunNotice service')
      globalThis.localStorage.clear()
      expect(notice.acknowledged()).toBe(false)
      notice.acknowledge()
      expect(notice.acknowledged()).toBe(true)
      expect(globalThis.localStorage.getItem(NOTICE_STORAGE_KEY)).toBe(NOTICE_VERSION)
      globalThis.localStorage.clear()
    } finally {
      await ctx.fiber.dispose()
    }
    expect(locale.bind(COMMON_NS)(TITLE_KEY)).toBe(TITLE_KEY)
  })

  it('puts the version row in the stock version row\'s place when the page carries both versions, and adds the versions line only while a layout is in force', async () => {
    Reflect.set(globalThis, VERSIONS_GLOBAL, { delorun: '0.1.0', dsh: '0.2.2-rc.3' })
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.provide('sessions', {})
      new TestRemote(ctx, { settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })) } })
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      const slots = ctx.get('slots')
      if (slots === undefined) throw new Error('no slot registry')
      slots.register({ name: 'root', children: { 'settings.general.item': { kind: 'list', scope: 'root' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('settings.general.item', {})}</>)
      await ctx.plugin({ inject: [], apply: connectionApply }).await()
      await ctx.plugin({ inject, apply }).await()
      const rows = slots.entries('settings.general.item')
      const row = rows.find(entry => entry.options.id === VERSION_ROW.id)
      expect(row?.options).toMatchObject({ id: VERSION_ROW.id, priority: VERSION_ROW.priority })
      expect(VERSION_ROW).toEqual({ id: 'current-version', priority: -1 })
      const face = row?.inject?.()
      if (face === undefined || !('versions' in face) || !('t' in face) || typeof face.t !== 'function') throw new Error('no row face')
      expect(face.versions).toEqual({ delorun: '0.1.0', dsh: '0.2.2-rc.3' })
      expect(face.t('version.delorun', { version: '0.1.0' })).toBe('Delorun version: 0.1.0')
      const ids = (): string[] => slots.entries('settings.general.item').map(entry => String(entry.options.id)).sort()
      // Without the layout registry, the flat list keeps the version row alone.
      expect(ids()).toEqual([VERSION_ROW.id, UPDATE_CHECK_ITEM.id].sort())
      const text = (): string => ''
      const layout: SettingsLayout = { groups: [], other: { label: text, itemsLabel: text }, search: { placeholder: text, empty: text } }
      const layouts = new SettingsLayoutRegistry()
      ctx.provide('settingsLayout', layouts)
      await new Promise(resolve => setTimeout(resolve, 0))
      // The registry alone, with no layout in force, still shows the flat list.
      expect(ids()).toEqual([VERSION_ROW.id, UPDATE_CHECK_ITEM.id].sort())
      const unregisterLayout = layouts.register(layout)
      const line = slots.entries('settings.general.item').find(entry => entry.options.id === VERSIONS_ITEM.id)
      expect(line?.options).toMatchObject({ order: VERSIONS_ITEM.order })
      expect(line?.inject?.()).toEqual({ versions: { delorun: '0.1.0', dsh: '0.2.2-rc.3' } })
      // A second change while in force registers nothing twice.
      const unregisterSecond = layouts.register(layout)
      expect(ids()).toEqual([VERSION_ROW.id, UPDATE_CHECK_ITEM.id, VERSIONS_ITEM.id].sort())
      unregisterSecond()
      unregisterLayout()
      expect(ids()).toEqual([VERSION_ROW.id, UPDATE_CHECK_ITEM.id].sort())
      layouts.register(layout)
      expect(ids()).toContain(VERSIONS_ITEM.id)
    } finally {
      Reflect.deleteProperty(globalThis, VERSIONS_GLOBAL)
      await ctx.fiber.dispose()
    }
  })
})
