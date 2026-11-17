/**
 * The contents of the theme control's menu: the themes, light or dark, and the way back to how the page started. It loads
 * the first time the menu opens.
 *
 * @module @delorun/site-design/theme-menu
 */
import { useEffect } from 'react'
import { ChoiceGroup } from '../../brand/src/settings/ChoiceGroup.tsx'
import { ThemePicker } from '../../brand/src/settings/AppearancePickers.tsx'
import { LOOK_SWATCHES } from './look-swatches.ts'
import { setLook, useLook } from './look-store.ts'
import { announceLook } from './look-toast.tsx'
import { KNOWN_LOOKS, type Look, type LookId } from './looks.ts'
import type { ThemeCopy } from './shell-copy.ts'
import { BackToStart } from './back-to-start.tsx'

/** The themes the menu offers; Custom is the setup strip's. */
const PRESETS = KNOWN_LOOKS.filter((id): id is Exclude<LookId, 'custom'> => id !== 'custom')

/**
 * The menu's contents.
 * @param props.copy - the control's text.
 * @param props.onReady - called once the contents are drawn, so the menu can be placed by its real size.
 * @returns the contents.
 */
export default function ThemeMenu({ copy, onReady }: { copy: ThemeCopy; onReady: () => void }) {
  const look = useLook()
  useEffect(onReady, [onReady])
  const change = (next: Look): void => {
    setLook(next)
    announceLook(copy, look, next)
  }
  return (
    <div className="flex flex-col gap-4">
      <ThemePicker label={copy.themes} value={look.look === 'custom' ? 'soft' : look.look}
        themes={PRESETS.map(id => ({ value: id, label: copy.names[id], ...LOOK_SWATCHES[id]! }))}
        onChange={id => change({ ...look, look: id, contrast: 'default' })} />
      <ChoiceGroup label={copy.scheme} value={look.scheme ?? 'device'} disabled={false} fill
        options={[{ value: 'device', label: copy.device }, { value: 'light', label: copy.light }, { value: 'dark', label: copy.dark }]}
        onChange={scheme => change({ ...look, scheme: scheme === 'device' ? undefined : scheme })} />
      <BackToStart copy={copy} className="self-start" />
    </div>
  )
}
