/** Screen 3: whether agents in the workspace may use a web browser. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserSetupStore } from '@delorun/browser-setup'
import { BrowserChoices } from '@delorun/browser-setup/client'
import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { DialogFooter } from '../footer.tsx'
import type { Problem } from '../flow.ts'
import type { Translate } from '../locales.ts'
import { problemText } from '../problems.ts'
import type { BrowserChoice } from '../../wire.ts'
import css from './screens.module.css'

/** What the browser screen reads and opens, injected by the plugin. */
export interface BrowserFace {
  /** The page's copy of whether Browser is ready. */
  readonly setup: BrowserSetupStore
  /** The studio's Settings shell. */
  readonly settings: {
    /**
     * Whether a Settings shell exists on this page.
     * @returns true when {@link open} does something.
     */
    available(): boolean
    /**
     * Open one Settings section.
     * @param section - a registered `settings.section` id.
     */
    open(section: string): void
  }
}

/** The Settings section that lists the plugins, where the Browser plugin is turned on. */
export const PLUGINS_SECTION = 'plugins'

/** The props of the browser screen. */
export interface BrowserScreenProps {
  /** This plugin's copy. */
  readonly t: Translate
  /** The readiness store and the Settings opener. */
  readonly browser: BrowserFace
  /** The choice in effect: the person's pick, else the one that follows whether Browser is on. */
  readonly choice: BrowserChoice
  /** Whether a request is running. */
  readonly busy: boolean
  /** The reason the last attempt failed. */
  readonly problem: Problem | undefined
  /** Whether Create now is offered. */
  readonly canCreateNow: boolean
  /**
   * Choose the isolated browser or none.
   * @param choice - the choice.
   */
  readonly onChoice: (choice: BrowserChoice) => void
  /** Go on to the model screen. */
  readonly onContinue: () => void
  /** Create the workspace with the choices made so far. */
  readonly onCreateNow: () => void
  /** Go back to the place screen. */
  readonly onBack: () => void
}

/**
 * The browser screen. It reads whether Browser is ready when it opens and whenever the window regains focus, so a need
 * the person met in a terminal clears without leaving the screen.
 * @param props - the readiness, the choice and what changes it.
 * @returns the screen.
 */
export function BrowserScreen({ t, browser, choice, busy, problem, canCreateNow, onChoice, onContinue, onCreateNow, onBack }: BrowserScreenProps): ReactNode {
  const { setup, settings } = browser
  const readiness = useSyncExternalStore(setup.subscribe, setup.getSnapshot)
  useEffect(() => {
    void setup.refresh()
    const again = (): void => { void setup.refresh() }
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('focus', again) }
  }, [setup])
  const notAdded = (
    <div className={css.notAdded}>
      <span>{t('browser.notAdded')}</span>
      {settings.available() && <Button variant="outline" size="sm" onClick={() => { settings.open(PLUGINS_SECTION) }}>{t('browser.openPlugins')}</Button>}
    </div>
  )
  return (
    <div className={css.screen}>
      <BrowserChoices t={t} heading={t('browser.heading')} choice={choice} onChoice={onChoice} disabled={busy} readiness={readiness} planned
        notAdded={notAdded} onRetry={() => { void setup.refresh() }} onOpenSettings={(section) => { settings.open(section) }} />
      {problem !== undefined && <p className={css.failure} role="alert">{problemText(t, problem)}</p>}
      <DialogFooter back={{ label: t('back'), onClick: onBack, disabled: busy }}
        extra={{ label: t('createNow'), onClick: onCreateNow, disabled: busy || !canCreateNow }}
        primary={{ label: t('continue'), onClick: onContinue, disabled: busy }} />
    </div>
  )
}
