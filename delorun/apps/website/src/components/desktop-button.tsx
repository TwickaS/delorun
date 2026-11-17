/**
 * The desktop app's download button, the hero's quiet second action. While no platform has a download address it is a
 * real button marked unavailable: reachable by keyboard, described by a note that links the roadmap, and the same with
 * scripts off. Filling in an address in `config.ts` turns it on for that platform, in the same place, as a plain link
 * to the address, which works with scripts off. An address that is not `https` on an allowed place is never offered.
 *
 * @module @delorun/website/desktop-button
 */
import { useEffect, useId, useState } from 'react'
import { Button, Link } from '@brand'
import { ButtonLink } from '@brand/button-link.web.tsx'
import { DESKTOP_DOWNLOAD_PLACES, DESKTOP_DOWNLOADS, DESKTOP_PLATFORMS, type DesktopPlatform } from '../site/config.ts'
import { COPY } from '../site/copy.ts'

/** What the button offers: nothing yet, or one platform's download. */
export type DesktopOffer =
  | { readonly available: false }
  | { readonly available: true, readonly platform: DesktopPlatform, readonly href: string }

/**
 * Whether an address may be offered as the desktop download: `https`, with no credentials, under one of
 * {@link DESKTOP_DOWNLOAD_PLACES}.
 * @param href - the address.
 * @returns true when it may be offered.
 */
export function isAllowedDownload(href: string): boolean {
  if (!URL.canParse(href)) return false
  const url = new URL(href)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false
  return DESKTOP_DOWNLOAD_PLACES.some(place => url.hostname === place.host && url.pathname.startsWith(place.path))
}

/**
 * The download to offer: the visitor's platform when it has an address, else the first platform that has one.
 * @param downloads - the address for each platform; an empty address, or one {@link isAllowedDownload} refuses, means no download.
 * @param platform - the visitor's platform, when known.
 * @returns the offer, unavailable while every address is empty.
 */
export function desktopOffer(downloads: Readonly<Record<DesktopPlatform, string>>, platform: DesktopPlatform | undefined): DesktopOffer {
  const order = platform === undefined ? DESKTOP_PLATFORMS : [platform, ...DESKTOP_PLATFORMS.filter(other => other !== platform)]
  for (const candidate of order) {
    const href = downloads[candidate].trim()
    if (href !== '' && isAllowedDownload(href)) return { available: true, platform: candidate, href }
  }
  return { available: false }
}

/**
 * The visitor's desktop platform from the browser's user agent. A phone or tablet has none, even where its user agent
 * names Mac OS X.
 * @param userAgent - the browser's user agent.
 * @returns the platform, or undefined.
 */
export function detectPlatform(userAgent: string): DesktopPlatform | undefined {
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return undefined
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/Windows/i.test(userAgent)) return 'windows'
  return undefined
}

/** The download arrow beside the label. */
const ICON = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" />
  </svg>
)

/**
 * The button and its note.
 * @param props.downloads - the address for each platform; the site's configuration unless a test passes its own.
 * @param props.className - extra classes for the wrapper.
 * @returns the button, unavailable with its note while there is no download, else a link to the download.
 */
export function DesktopButton({ downloads = DESKTOP_DOWNLOADS, className }: { downloads?: Readonly<Record<DesktopPlatform, string>>, className?: string }) {
  const noteId = useId()
  const [platform, setPlatform] = useState<DesktopPlatform | undefined>(undefined)
  useEffect(() => { setPlatform(detectPlatform(navigator.userAgent)) }, [])
  const offer = desktopOffer(downloads, platform)
  const copy = COPY.desktop
  return (
    <div className={`flex flex-col items-start gap-2 ${className ?? ''}`.trim()}>
      {offer.available
        ? (
            <ButtonLink href={offer.href} variant="secondary" icon={ICON}>{copy.labelFor[offer.platform]}</ButtonLink>
          )
        : <Button type="button" variant="secondary" unavailable aria-describedby={noteId} icon={ICON}>{copy.label}</Button>}
      <p id={noteId} className="min-h-5 text-sm text-(--dl-text-muted)">
        {offer.available ? null : <>{copy.note.before}<Link href={copy.note.href}>{copy.note.linkText}</Link>{copy.note.after}</>}
      </p>
    </div>
  )
}
