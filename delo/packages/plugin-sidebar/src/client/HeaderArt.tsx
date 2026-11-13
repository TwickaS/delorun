/**
 * The header art in upstream's `sidebar.backdrop` seat, drawn as the
 * sidebar's settings choose: behind the sidebar's top at a strength, or as a
 * pill beside the brand, which marks itself `data-backdrop-plain` so the
 * brand keeps its colours; nothing when they choose none. Behind the sidebar's
 * top the art mounts the edge filters under `INK_EDGE_IDS`, through which
 * upstream's sidebar draws its light brand and toggle, so they read on every
 * scene while the whole art stays in view.
 */
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarSettings } from '../config.ts'
import { INK_EDGE_IDS, InkEdgeFilters, StageBackdrop } from './StageArt.tsx'
import css from './StageArt.module.css'

/** What the art reads. */
export type HeaderArtInjected = {
  hooks: {
    /** The sidebar's settings. */
    settings: HostObservable<SidebarSettings>
  }
}

/**
 * Render the chosen art.
 * @param props - the settings hook.
 * @returns the art, or nothing for none.
 */
export function HeaderArt({ useSettings }: InjectFace<HeaderArtInjected>) {
  const scene = useSettings(settings => settings.headerArt)
  const palette = useSettings(settings => settings.artPalette)
  const strength = useSettings(settings => settings.artStrength)
  const fade = useSettings(settings => settings.artFade)
  const style = useSettings(settings => settings.artStyle)
  const seed = useSettings(settings => settings.artSeed)
  if (scene === 'none') return null
  if (style === 'pill') {
    return (
      <span className={css.pill} data-backdrop-plain="">
        <StageBackdrop scene={scene} palette={palette} seed={seed} compact fade={false} />
      </span>
    )
  }
  return (
    <>
      <StageBackdrop scene={scene} palette={palette} seed={seed} strength={strength} fade={fade} />
      <InkEdgeFilters ids={INK_EDGE_IDS} />
    </>
  )
}
