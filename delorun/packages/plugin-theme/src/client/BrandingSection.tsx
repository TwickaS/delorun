/**
 * The Branding section of Settings: show or hide the mark, the person's own name, icon and greeting, and the note that
 * the sign-in pages show them too. Every value is checked here before it is written and again wherever it is read.
 */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Notice, TextField } from '@delorun/brand'
import { checkGreeting, checkName, checkUpload, DEFAULT_GREETING, DEFAULT_STORED_BRANDING, GREETING_PRESETS, resolveBranding, type StoredBranding } from '@delorun/brand/branding'
import { cardCss, ChoiceGroup, SettingHeading, SettingsCard } from '@delorun/settings-controls'
import { useState, type ChangeEvent } from 'react'
import { DEFAULT_SETTINGS, type ThemeSettings } from '../config.ts'
import { BrandIcon } from './BrandIcon.tsx'
import { publishBranding, useBranding } from './branding-store.ts'
import css from './BrandingSection.module.css'
import { useFormWrites } from './form-writes.ts'
import { sidebarBridge } from './sidebar-bridge.ts'

/** What the section reads and writes. */
export interface BrandingInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
}

/** The props the section reads. */
export type BrandingSectionProps = PropsLocale<'settings.delorunBranding'> & InjectFace<BrandingInjected>

type IconChoice = StoredBranding['icon']

const PICKER_PREVIEW = 48

/**
 * Read a file as base64.
 * @param file - the file.
 * @returns its bytes as base64.
 */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Render the section.
 * @param props - the section's dictionary and injected services.
 * @returns the section.
 */
export function BrandingSection({ t, settings }: BrandingSectionProps) {
  const { snapshot, disabled, failed, track } = useFormWrites(settings)
  const stored = (snapshot.value ?? DEFAULT_SETTINGS).branding
  const view = useBranding()
  const [problem, setProblem] = useState<{ readonly field: 'name' | 'greeting' | 'icon'; readonly text: string } | undefined>()
  const [picking, setPicking] = useState(false)
  const [customGreeting, setCustomGreeting] = useState(false)
  const write = (next: Partial<StoredBranding>): void => {
    const merged: StoredBranding = { ...stored, ...next }
    publishBranding(merged)
    track(settings.set('branding', merged))
  }
  const saveName = (text: string): void => {
    if (text.trim() === '') { setProblem(undefined); write({ name: '' }); return }
    const checked = checkName(text)
    if (!checked.ok) { setProblem({ field: 'name', text: t('name.problem') }); return }
    setProblem(undefined)
    write({ name: checked.value })
  }
  const saveGreeting = (text: string): void => {
    if (text.trim() === '') { setProblem(undefined); write({ greeting: '' }); return }
    const checked = checkGreeting(text)
    if (!checked.ok) { setProblem({ field: 'greeting', text: t('greeting.problem') }); return }
    setProblem(undefined)
    write({ greeting: checked.value })
  }
  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    const base64 = await base64Of(file)
    const checked = checkUpload(base64, file.type === '' ? undefined : file.type)
    if (!checked.ok) { setProblem({ field: 'icon', text: t('icon.problem') }); return }
    setProblem(undefined)
    write({ icon: 'upload', upload: base64 })
  }
  const bridge = sidebarBridge()
  const pickedName = resolveBranding(stored).name
  const greetingIsPreset = (GREETING_PRESETS as readonly string[]).includes(view.greeting)
  const showCustom = customGreeting || (!greetingIsPreset && stored.greeting !== '')
  return (
    <SettingsCard id="delorun-branding" title={t('title')} className={css.section}>
      {view.notice !== undefined && <Notice tone="warning" title={t('notice')}>{view.notice}</Notice>}
      <section className={`${cardCss.block} ${cardCss.row}`} aria-labelledby="delorun-branding-show">
        <SettingHeading id="delorun-branding-show" title={t('show')} lead={t('show.lead')} />
        <Switch checked={stored.showMark} disabled={disabled} label={t('show')} onChange={(next) => { write({ showMark: next }) }} />
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-name">
        <SettingHeading id="delorun-branding-name" title={t('name')} lead={t('name.lead')} />
        <TextField
          label={t('name')}
          defaultValue={stored.name}
          placeholder={t('name.placeholder')}
          maxLength={80}
          disabled={disabled}
          error={problem?.field === 'name' ? problem.text : undefined}
          onBlur={(event) => { saveName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') saveName(event.currentTarget.value) }}
        />
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-icon">
        <SettingHeading id="delorun-branding-icon" title={t('icon')} lead={t('icon.lead')} />
        <div className={css.iconRow}>
          <span className={css.preview}><BrandIcon branding={{ ...view, showMark: true }} size={PICKER_PREVIEW} /></span>
          <ChoiceGroup<IconChoice>
            label={t('icon')}
            value={stored.icon}
            disabled={disabled}
            options={[{ value: 'mark', label: t('icon.mark') }, { value: 'picked', label: t('icon.picked') }, { value: 'upload', label: t('icon.upload') }]}
            onChange={(next) => {
              if (next === 'picked') setPicking(true)
              else if (next === 'mark' || stored.upload !== '') write({ icon: next })
            }}
          />
        </div>
        <div className={css.iconActions}>
          <Button variant="secondary" disabled={disabled || bridge === undefined} onClick={() => { setPicking(true) }}>{t('icon.pick')}</Button>
          <label className={css.file}>
            <span>{t('icon.choose')}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={(event) => { void upload(event) }} />
          </label>
        </div>
        {problem?.field === 'icon' && <p className={cardCss.failure} role="alert">{problem.text}</p>}
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-greeting">
        <SettingHeading id="delorun-branding-greeting" title={t('greeting')} lead={t('greeting.lead')} />
        <ChoiceGroup<string>
          label={t('greeting')}
          value={showCustom ? 'custom' : view.greeting}
          disabled={disabled}
          options={[...GREETING_PRESETS.map(text => ({ value: text, label: text })), { value: 'custom', label: t('greeting.custom') }]}
          onChange={(next) => {
            if (next === 'custom') { setCustomGreeting(true); return }
            setCustomGreeting(false)
            setProblem(undefined)
            write({ greeting: next === DEFAULT_GREETING ? '' : next })
          }}
        />
        {showCustom && (
          <TextField
            label={t('greeting.custom')}
            defaultValue={stored.greeting}
            placeholder={t('greeting.placeholder')}
            maxLength={200}
            disabled={disabled}
            error={problem?.field === 'greeting' ? problem.text : undefined}
            onBlur={(event) => { saveGreeting(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') saveGreeting(event.currentTarget.value) }}
          />
        )}
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-signin">
        <SettingHeading id="delorun-branding-signin" title={t('signin')} lead={t('signin.lead')} />
        <Button variant="ghost" disabled={disabled} onClick={() => { setProblem(undefined); setCustomGreeting(false); write({ ...DEFAULT_STORED_BRANDING }) }}>{t('reset')}</Button>
      </section>
      {failed && <p className={cardCss.failure} role="alert">{t('saveFailed')}</p>}
      {picking && bridge !== undefined && (
        <bridge.service.IconPickerDialog
          title={pickedName}
          icon={bridge.parse(stored.pickedIcon)}
          onSave={(icon) => { setPicking(false); if (icon !== null) write({ icon: 'picked', pickedIcon: JSON.stringify(icon) }) }}
          onClose={() => { setPicking(false) }}
        />
      )}
    </SettingsCard>
  )
}
