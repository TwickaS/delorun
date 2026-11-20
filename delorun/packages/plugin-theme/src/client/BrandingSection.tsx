/**
 * The Branding section of Settings: show or hide the mark, the person's own name, icon and greeting, and the note that
 * the sign-in pages show them too. Every value is checked here before it is written and again wherever it is read.
 */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Notice, TextField } from '@delorun/brand'
import { IconPicker } from '@delorun/brand/icon-picker'
import type { IconPickerLocaleKey } from '@delorun/brand/icon-picker-locales'
import { checkGreeting, checkImageBytes, checkName, checkUpload, DEFAULT_GREETING, STUDIO_ICON_UPLOAD_PATH, ICON_TYPE_HEADER, DEFAULT_STORED_BRANDING, GREETING_PRESETS, resolveBranding, type StoredBranding } from '@delorun/brand/branding'
import { cardCss, ChoiceGroup, RadioList, SettingHeading, SettingsCard } from '@delorun/settings-controls'
import { useRef, useState, type ChangeEvent } from 'react'
import { DEFAULT_SETTINGS, type ThemeSettings } from '../config.ts'
import { BrandIcon, readPicked } from './BrandIcon.tsx'
import { publishBranding, useBranding } from './branding-store.ts'
import css from './BrandingSection.module.css'
import { useFormWrites } from './form-writes.ts'

/** What the section reads and writes. */
export interface BrandingInjected {
  /** The theme settings, stored by the host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /** The icon picker's translate function. */
  readonly pickerT: (key: IconPickerLocaleKey, params?: Readonly<Record<string, string>>) => string
}

/** The props the section reads. */
export type BrandingSectionProps = PropsLocale<'settings.delorunBranding'> & InjectFace<BrandingInjected>

type IconChoice = StoredBranding['icon']

const PICKER_PREVIEW = 48

/**
 * Send image bytes to the host, which checks them again and stores them as the home's icon file.
 * @param bytes - the image.
 * @param type - the image's type, which the host compares with the first bytes.
 * @returns the stored image's hash, or undefined when the host refused it or could not be reached.
 */
async function storeImage(bytes: Uint8Array, type: string): Promise<string | undefined> {
  try {
    const response = await fetch(STUDIO_ICON_UPLOAD_PATH, { method: 'POST', headers: { 'content-type': 'application/octet-stream', [ICON_TYPE_HEADER]: type }, body: bytes as BodyInit, credentials: 'same-origin' })
    if (!response.ok) return undefined
    const answer: unknown = await response.json()
    const hash = typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'hash') : undefined
    return typeof hash === 'string' ? hash : undefined
  } catch (_unreachable) {
    // The studio shows the same plain problem for a refusal and for no answer.
    return undefined
  }
}

/**
 * Render the section.
 * @param props - the section's dictionary and injected services.
 * @returns the section.
 */
export function BrandingSection({ t, settings, pickerT }: BrandingSectionProps) {
  const { snapshot, disabled, failed, track } = useFormWrites(settings)
  const stored = (snapshot.value ?? DEFAULT_SETTINGS).branding
  const view = useBranding()
  const [problem, setProblem] = useState<{ readonly field: 'name' | 'greeting' | 'icon'; readonly text: string } | undefined>()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [picking, setPicking] = useState(false)
  const [customGreeting, setCustomGreeting] = useState(false)
  const write = (next: Partial<StoredBranding>): void => {
    const merged: StoredBranding = { ...stored, ...next }
    publishBranding(merged)
    track(settings.set('branding', merged))
    // A home that stored the image in the row moves it to the icon file on this save.
    if (merged.upload !== '' && merged.uploadHash === '') track(moveToFile(merged))
  }
  const moveToFile = async (record: StoredBranding): Promise<boolean> => {
    const checked = checkUpload(record.upload)
    if (!checked.ok) return false
    const hash = await storeImage(checked.bytes, checked.type)
    if (hash === undefined) return false
    const moved: StoredBranding = { ...record, upload: '', uploadHash: hash }
    publishBranding(moved)
    return await settings.set('branding', moved)
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
    const bytes = new Uint8Array(await file.arrayBuffer())
    const checked = checkImageBytes(bytes, file.type === '' ? undefined : file.type)
    const hash = checked.ok ? await storeImage(bytes, checked.type) : undefined
    if (hash === undefined) { setProblem({ field: 'icon', text: t('icon.problem') }); return }
    setProblem(undefined)
    write({ icon: 'upload', uploadHash: hash, upload: '' })
  }
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
          hideLabel
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
            wrap
            value={stored.icon}
            disabled={disabled}
            options={[{ value: 'mark', label: t('icon.mark') }, { value: 'picked', label: t('icon.picked') }, { value: 'upload', label: t('icon.upload') }]}
            onChange={(next) => {
              if (next === 'picked') setPicking(true)
              else if (next === 'mark' || stored.uploadHash !== '' || stored.upload !== '') write({ icon: next })
            }}
          />
        </div>
        <div className={css.iconActions}>
          <Button variant="secondary" disabled={disabled} onClick={() => { setPicking(true) }}>{t('icon.pick')}</Button>
          <Button variant="secondary" disabled={disabled} onClick={() => { fileInput.current?.click() }}>{t('icon.choose')}</Button>
          <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={(event) => { void upload(event) }} />
        </div>
        {problem?.field === 'icon' && <p className={cardCss.failure} role="alert">{problem.text}</p>}
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-greeting">
        <SettingHeading id="delorun-branding-greeting" title={t('greeting')} lead={t('greeting.lead')} />
        <RadioList<string>
          label={t('greeting')}
          value={showCustom ? 'custom' : view.greeting}
          disabled={disabled}
          rows={[
            ...GREETING_PRESETS.map(text => ({ value: text, label: text })),
            {
              value: 'custom',
              label: t('greeting.custom'),
              detail: (
                <TextField
                  label={t('greeting.custom')}
                  hideLabel
                  defaultValue={stored.greeting}
                  placeholder={t('greeting.placeholder')}
                  maxLength={200}
                  disabled={disabled}
                  error={problem?.field === 'greeting' ? problem.text : undefined}
                  onBlur={(event) => { saveGreeting(event.target.value) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') saveGreeting(event.currentTarget.value) }}
                />
              ),
            },
          ]}
          onChange={(next) => {
            if (next === 'custom') { setCustomGreeting(true); return }
            setCustomGreeting(false)
            setProblem(undefined)
            write({ greeting: next === DEFAULT_GREETING ? '' : next })
          }}
        />
      </section>
      <section className={cardCss.block} aria-labelledby="delorun-branding-signin">
        <SettingHeading id="delorun-branding-signin" title={t('signin')} lead={t('signin.lead')} />
        <div className={css.iconActions}>
          <Button variant="secondary" disabled={disabled} onClick={() => { setProblem(undefined); setCustomGreeting(false); write({ ...DEFAULT_STORED_BRANDING }) }}>{t('reset')}</Button>
        </div>
      </section>
      {failed && <p className={cardCss.failure} role="alert">{t('saveFailed')}</p>}
      {picking && (
        <IconPicker
          t={pickerT}
          title={t('picker.title')}
          subtitle={t('picker.lead')}
          target={{ workspaceId: 'branding', title: pickedName, color: 'blue', icon: readPicked(stored.pickedIcon) }}
          onSave={(icon) => { setPicking(false); if (icon !== null) write({ icon: 'picked', pickedIcon: JSON.stringify(icon) }) }}
          onClose={() => { setPicking(false) }}
        />
      )}
    </SettingsCard>
  )
}
