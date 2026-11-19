/**
 * The home page's frame and shared sections: the header with the mark, the main links and the theme dot; the reasons
 * for tinkerers; the install block; the sign-up and the footer.
 *
 * @module @delorun/website/home/shell
 */
import type { ReactNode } from 'react'
import { ProductMark } from '@design/product-mark.tsx'
import { note } from './effects.ts'
import { SiteFooter } from '@design/site-footer.tsx'
import { SiteLink } from '@design/site-header.tsx'
import { FOOTER_COPY, FOOTER_LINKS, HEADER_LINKS } from '@/site/shell-copy.ts'
import { COPY, INSTALL_COMMANDS } from '@/site/copy.ts'
import { GITHUB_URL } from '@/site/config.ts'
import { usePackageManager } from '@/components/package-manager.tsx'
import { DesktopButton } from '@/components/desktop-button.tsx'
import { CommandBlock, Install, ScriptsOff } from '@/components/install.tsx'
import { SignupSection } from '@/components/signup-section.tsx'
import { LightboxProvider } from './Lightbox.tsx'
import { EffectStatus, ThemeDot } from './ThemeDot.tsx'
import s from './home.module.css'

/**
 * The GitHub mark (Octicons `mark-github`, 16 px grid).
 * @returns the icon, hidden from assistive technology.
 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  )
}

/**
 * The header: the mark, the main links, the effects status, the theme control and the "Star" button for the GitHub
 * repository, which is the page's only link to it.
 * @returns the header landmark.
 */
function Header() {
  const links = HEADER_LINKS.filter(link => link.href !== GITHUB_URL)
  return (
    <header className={s.header}>
      <a href="/" className={s.brand}>
        <ProductMark size={26} />
        <span>Delorun</span>
      </a>
      <nav aria-label="Main" className={s.nav}>
        {links.map(link => <SiteLink key={link.href} link={link} className={s.navLink} />)}
        <EffectStatus />
        <ThemeDot />
        <a href={GITHUB_URL} className={s.starButton} aria-label="Star Delorun on GitHub">
          <GitHubMark />
          <span className={s.starLabel}>Star</span>
        </a>
      </nav>
    </header>
  )
}

/**
 * The frame: skip link, header, the page's sections, the sign-up and the footer, inside the lightbox's provider.
 * @param props.children - the page's sections.
 * @returns the page.
 */
export function HomeFrame({ children }: { children: ReactNode }) {
  return (
    <LightboxProvider>
      <div className={s.page}>
        <a href="#content" className={s.skip}>Skip to the page</a>
        <ScriptsOff />
        <Header />
        <main id="content" tabIndex={-1} className={s.main}>{children}</main>
        <SignupSection />
        <SiteFooter copy={FOOTER_COPY} links={FOOTER_LINKS} inner="max-w-[1440px] px-4 sm:px-6" />
      </div>
    </LightboxProvider>
  )
}

/**
 * The install command with its package-manager choice and the desktop button.
 * @param props.big - true to set the command at headline size.
 * @returns the block.
 */
export function InstallBlock({ big = false }: { big?: boolean }) {
  const [manager, setManager] = usePackageManager()
  // The header's readout logs a copy of the command; the copy button itself belongs to the site's code block.
  const logCopy = (event: { target: EventTarget }) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button?.getAttribute('aria-label') === COPY.hero.copyLabel) note(`✓ copied ${INSTALL_COMMANDS[manager]}`)
  }
  return (
    <div className={s.install} data-big={big} onClickCapture={logCopy}>
      {big ? <CommandBlock command={INSTALL_COMMANDS[manager]} size="lg" main /> : <Install manager={manager} onChange={setManager} />}
      <DesktopButton />
    </div>
  )
}

/** The reasons, in order. */
const REASONS: readonly { readonly title: string; readonly text: string }[] = [
  { title: 'Plugins all the way down.', text: 'Delorun is built from plugins. Turn any of them off, add more, or describe one and let Delorun write its first files.' },
  { title: 'It edits itself. You can undo it.', text: 'Changes to Delorun’s own files wait for your review, and every change to what it runs is listed with Undo.' },
  { title: 'Your setup is yours to keep.', text: 'Save the whole setup as a version, go back to an earlier one, or carry it to another computer.' },
  { title: 'It runs on your computer.', text: 'Your keys, your models, your files, under the MIT licence. Reach it from your phone over Tailscale when you are out.' },
]

/**
 * The case for tinkerers: four reasons, numbered because they build on each other, set large.
 * @param props.heading - the section's heading.
 * @returns the section.
 */
export function Reasons({ heading }: { heading: string }) {
  return (
    <section aria-labelledby="reasons" className={s.reasons}>
      <h2 id="reasons" className={s.reasonsTitle}>{heading}</h2>
      <ol className={s.reasonList}>
        {REASONS.map((reason, index) => (
          <li key={reason.title} className={s.reason}>
            <span className={s.reasonNumber} aria-hidden="true">{index + 1}</span>
            <h3 className={s.reasonTitle}>{reason.title}</h3>
            <p className={s.reasonText}>{reason.text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * The closing install section.
 * @param props.heading - its heading.
 * @returns the section.
 */
export function Closing({ heading }: { heading: string }) {
  const { platform, status } = COPY.hero
  return (
    <section aria-labelledby="closing" className={s.closing}>
      <h2 id="closing" className={s.closingTitle}>{heading}</h2>
      <InstallBlock big />
      <p className={s.closingNote}>
        {platform.before}<a href={platform.href}>{platform.linkText}</a>{platform.after}
        {status.before}<a href={status.href}>{status.linkText}</a>{status.after}
      </p>
    </section>
  )
}
