/**
 * The film: one real job told in five real screenshots on a stage that stays in place while the page scrolls. Each
 * chapter cuts to its picture wide, then the camera pushes in on the part that matters, while the clock shows the time
 * printed on that screenshot. The first push waits until the stage has reached the top of the window, so a section
 * above can hand over to the first picture as it stands before the push.
 *
 * @module @delorun/website/home/film
 */
import { useEffect, useRef, useState } from 'react'
import { useOpenShot } from './Lightbox.tsx'
import { MS } from './motion.ts'
import { lodUrl } from './pictures.ts'
import { FILM, SIZES, type Chapter } from './shots.ts'
import s from './home.module.css'

/**
 * The transform that pushes the camera in on a chapter's focus point inside a stage.
 * @param chapter - the chapter.
 * @param stage - the stage's size.
 * @param push - true once the camera has moved in.
 * @returns the CSS transform for the picture, which is laid out to cover the stage.
 */
function camera(chapter: Chapter, stage: { width: number; height: number }, push: boolean, dark = false): string {
  const narrow = stage.width < 640
  const { width: iw, height: ih } = narrow ? SIZES.phone : SIZES.computer
  const cover = Math.max(stage.width / iw, stage.height / ih)
  // A phone capture already reads at this size, so on a phone the camera tilts down to the moment instead of pushing in.
  const scale = cover * (push && !narrow ? chapter.zoom : 1)
  const w = iw * scale
  const h = ih * scale
  const focus = dark ? chapter.dark?.focus ?? chapter.focus : chapter.focus
  const [fx, fy] = narrow ? [0.5, push ? chapter.phone.focusY : Math.max(0, chapter.phone.focusY - 0.16)] : focus
  // Put the focus point at the stage's centre, but never past the picture's edges.
  const x = Math.min(0, Math.max(stage.width - w, stage.width / 2 - fx * w))
  const y = Math.min(0, Math.max(stage.height - h, stage.height / 2 - fy * h))
  return `translate(${x}px, ${y}px) scale(${scale})`
}

/**
 * The film.
 * @param props.id - the heading's id.
 * @param props.heading - the section's heading, for screen readers and as the stage's title.
 * @returns the section.
 */
export function Film({ id, heading }: { id: string; heading: string }) {
  const [active, setActive] = useState(0)
  const [pushed, setPushed] = useState(false)
  const [arrived, setArrived] = useState(false)
  const section = useRef<HTMLElement>(null)
  const [stage, setStage] = useState<{ width: number; height: number } | undefined>(undefined)
  const markers = useRef<(HTMLDivElement | null)[]>([])
  const frame = useRef<HTMLDivElement>(null)
  const open = useOpenShot()

  useEffect(() => {
    const element = frame.current
    if (element === null) return
    const measure = () => setStage({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset['index']))
      }
    }, { rootMargin: '-50% 0px -50% 0px' })
    for (const marker of markers.current) if (marker !== null) observer.observe(marker)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = section.current
    if (element === null) return
    const check = () => setArrived(element.getBoundingClientRect().top <= 1)
    check()
    addEventListener('scroll', check, { passive: true })
    return () => removeEventListener('scroll', check)
  }, [])

  // Cut wide, then push in.
  useEffect(() => {
    setPushed(false)
    if (!arrived || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setTimeout(() => setPushed(true), MS.scene / 2)
    return () => window.clearTimeout(timer)
  }, [active, arrived])

  const chapter = FILM[active] ?? FILM[0]
  const narrow = stage !== undefined && stage.width < 640
  return (
    <section ref={section} aria-labelledby={id} className={s.film} style={{ ['--chapters' as string]: FILM.length }}>
      <h2 id={id} className={s.srOnly}>{heading}</h2>
      <div className={s.filmSticky}>
        <div className={s.filmFrame} ref={frame} data-handover="">
          {FILM.map((each, index) => (
            <button
              key={each.id + index}
              type="button"
              className={s.filmShot}
              data-active={index === active}
              data-shot={each.id}
              tabIndex={index === active ? 0 : -1}
              aria-hidden={index !== active}
              aria-label={`Enlarge: ${each.line}`}
              onClick={event => open(each.id, event.currentTarget)}
            >
              {narrow
                ? (
                    <picture className={s.pictureContents}>
                      <source type="image/avif" srcSet={lodUrl(each.phone.file, 3, 'avif')} />
                      <img loading="lazy" src={lodUrl(each.phone.file, 3, 'webp')} alt="" draggable={false} style={stage === undefined ? undefined : { ...SIZES.phone, transform: camera(each, stage, index === active && pushed) }} />
                    </picture>
                  )
                : (
                    <>
                      <picture className={s.pictureContents}>
                        <source type="image/avif" srcSet={lodUrl(each.id, 3, 'avif')} />
                        <img loading="lazy" src={lodUrl(each.id, 3, 'webp')} alt="" draggable={false} className={each.dark === undefined ? undefined : s.lightOnly} style={stage === undefined ? undefined : { ...SIZES.computer, transform: camera(each, stage, index === active && pushed) }} />
                      </picture>
                      {each.dark === undefined ? null : (
                        <picture className={s.pictureContents}>
                          <source type="image/avif" srcSet={lodUrl(each.dark.id, 3, 'avif')} />
                          <img loading="lazy" src={lodUrl(each.dark.id, 3, 'webp')} alt="" draggable={false} className={s.darkOnly} style={stage === undefined ? undefined : { ...SIZES.computer, transform: camera(each, stage, index === active && pushed, true) }} />
                        </picture>
                      )}
                    </>
                  )}
            </button>
          ))}
        </div>
        <div className={s.filmCaption}>
          <p className={s.filmLine} key={chapter?.line}>{chapter?.line}</p>
          <p className={s.filmDetail} key={chapter?.detail}>{chapter?.detail}</p>
          <div className={s.filmMeta} aria-hidden="true">
            <span className={s.filmClock}><span className={s.filmRec} />{chapter?.time ?? 'Later'}</span>
            <span className={s.filmCount}>{String(active + 1).padStart(2, '0')} / {String(FILM.length).padStart(2, '0')}</span>
            <ol className={s.filmTicks}>
              {FILM.map((each, index) => <li key={each.id + index} data-on={index <= active} />)}
            </ol>
          </div>
        </div>
      </div>
      <div className={s.filmMarkers}>
        {FILM.map((each, index) => (
          <div key={each.id + index} ref={el => { markers.current[index] = el }} data-index={index} className={s.filmMarker}>
            <p className={s.srOnly}>{each.line} {each.detail}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
