/**
 * The gate a living section loads through: the page renders the section's still, and the section's own script is
 * fetched only when the still nears the screen, so it never weighs on the first screen. The still and the section
 * share one fixed box, so nothing moves when the section arrives; with scripts off, or if the script fails to load, the
 * still stays.
 *
 * @module @delorun/website/near-screen
 */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'

/** How far below the screen a still may be when its section starts to load. */
const AHEAD = '800px 0px'

/** The props of {@link NearScreen}. */
export interface NearScreenProps {
  /** Fetches the section's module; its default export is the live section, which takes no props. */
  readonly load: () => Promise<{ readonly default: ComponentType }>
  /** The still, rendered on the server and kept until the section has loaded. */
  readonly still: ReactNode
  readonly className?: string | undefined
}

/**
 * Render the still, then the section once it has loaded.
 * @param props - see {@link NearScreenProps}.
 * @returns the still or the section.
 */
export function NearScreen({ load, still, className }: NearScreenProps) {
  const box = useRef<HTMLDivElement>(null)
  const [Section, setSection] = useState<ComponentType | undefined>(undefined)
  useEffect(() => {
    const element = box.current
    if (element === null) return
    let live = true
    const start = () => {
      load().then(module => { if (live) setSection(() => module.default) }, (error: unknown) => {
        // The section's script did not load (offline, or a new deploy removed the file); the still stays, as with scripts off.
        void error
      })
    }
    if (typeof IntersectionObserver === 'undefined') {
      start()
      return () => { live = false }
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      start()
    }, { rootMargin: AHEAD })
    observer.observe(element)
    return () => {
      live = false
      observer.disconnect()
    }
  }, [load])
  return <div ref={box} className={className}>{Section === undefined ? still : <Section />}</div>
}
