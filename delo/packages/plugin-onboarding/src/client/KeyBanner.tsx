/**
 * The calm inline banner above the message box while no model key works: upstream's "Add an API key" dialog is off in
 * Delo's studio (`credentialOnboarding: false` in `@delo/bundle-studio`), so this is the only nudge. It asks the key
 * test, which spends no tokens, once when the box mounts and every few seconds while it shows, so it leaves once a key
 * is added. A key test that cannot be read, or that cannot tell, shows nothing.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { KeyTestAnswer } from '../wire.ts'
import css from './KeyBanner.module.css'

/** How often the banner asks again while it shows, in milliseconds. */
export const KEY_RECHECK_MS = 5000

/** What the banner reads and calls. */
export interface KeyBannerInjected {
  /** @returns each model provider's key test, or undefined when the harness cannot be asked. */
  readonly keyTest: () => Promise<KeyTestAnswer | undefined>
  /** Open Settings at Models. */
  readonly openModels: () => void
}

/**
 * Whether the person has no working key: no provider that works, and none that might. A provider that is unreachable or
 * whose test failed might work, so it counts as a key. One with no model listing (`untested`, such as an account route
 * that needs a sign-in Delo does not offer) says nothing either way, so it is ignored.
 * @param answer - the key test's answer, or undefined when it could not be read.
 * @returns true when the banner should show.
 */
export function hasNoWorkingKey(answer: KeyTestAnswer | undefined): boolean {
  if (answer === undefined) return false
  return answer.providers.every(each => each.result === 'no-key' || each.result === 'rejected' || each.result === 'untested')
}

/** The props of the banner in the input dock: this plugin's copy and the services. */
export type KeyBannerProps = PropsLocale<'deloOnboarding'> & InjectFace<KeyBannerInjected>

/**
 * Render the banner while no key works.
 * @param props - this plugin's copy and the services.
 * @returns the banner, or nothing.
 */
export function KeyBanner({ t, keyTest, openModels }: KeyBannerProps): ReactNode {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let current = true
    const check = (): void => { void keyTest().then((answer) => { if (current) setMissing(hasNoWorkingKey(answer)) }) }
    check()
    // Only a showing banner can change, so a person with a key is never asked again.
    const timer = missing ? setInterval(check, KEY_RECHECK_MS) : undefined
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [keyTest, missing])
  if (!missing) return null
  return (
    <div className={css.banner} role="status">
      <span className={css.text}>{t('keyBanner.text')}</span>
      <button type="button" className={css.button} onClick={openModels}>{t('keyBanner.open')}</button>
    </div>
  )
}
