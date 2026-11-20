/**
 * The glyph by the sheet's title, drawn from the product icon sprite. Which glyph an action gets is decided by
 * [`face-id-icon-keys.ts`](./face-id-icon-keys.ts).
 */
import type { ReactNode } from 'react'
import {
  IconApiOutlineMedium, IconCheckCircleOutlineMedium, IconDownloadOutlineMedium, IconFolderOpenOutlineMedium,
  IconGlobeOutlineMedium, IconPluginPinwheelOutlineMedium, IconRefreshOutlineMedium, IconSettingsOutlineMedium, IconShieldOutlineMedium, IconTrashOutlineMedium, type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FaceIconKey } from './face-id-types.ts'

/** The glyph component of each key. */
const GLYPHS: Readonly<Record<FaceIconKey, (props: IconProps) => ReactNode>> = {
  // The sprite's `api-outline` draws a prompt, `>_`; its `code-outline` is a hash sign.
  terminal: IconApiOutlineMedium,
  shield: IconShieldOutlineMedium,
  download: IconDownloadOutlineMedium,
  check: IconCheckCircleOutlineMedium,
  folder: IconFolderOpenOutlineMedium,
  settings: IconSettingsOutlineMedium,
  plugin: IconPluginPinwheelOutlineMedium,
  trash: IconTrashOutlineMedium,
  globe: IconGlobeOutlineMedium,
  refresh: IconRefreshOutlineMedium,
}

/** Props of {@link FaceIdIcon}. */
export interface FaceIdIconProps {
  /** The glyph key; the shield when absent. */
  readonly icon: FaceIconKey | undefined
  readonly size?: number
}

/**
 * Render the header glyph.
 * @param props - see {@link FaceIdIconProps}.
 * @returns the icon, hidden from assistive technology.
 */
export function FaceIdIcon({ icon, size = 24 }: FaceIdIconProps): ReactNode {
  const Glyph = GLYPHS[icon ?? 'shield']
  return <Glyph size={size} />
}
