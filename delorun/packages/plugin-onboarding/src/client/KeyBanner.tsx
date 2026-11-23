/**
 * The calm inline banner above the message box while no model key works: upstream's "Add an API key" dialog is off in
 * Delorun's studio (`credentialOnboarding: false` in `@delorun/bundle-studio`), so this is the only nudge. It asks the key
 * test, which spends no tokens, once when the box mounts and again whenever the window regains focus while it shows, so it
 * leaves soon after a key is added elsewhere and never polls on a timer. A key test that cannot be read shows nothing.
 */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Alert } from '@delorun/brand/alert'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { KeyTestAnswer } from '../wire.ts'
import { DEEPSEEK_ROUTE } from '../wire.ts'
import css from './KeyBanner.module.css'

/** What the banner reads and calls. */
export interface KeyBannerInjected {
  /** @returns each model provider's key test, or undefined when the harness cannot be asked. */
  readonly keyTest: () => Promise<KeyTestAnswer | undefined>
  /** Open Settings at Models. */
  readonly openModels: () => void
}

/**
 * Whether the person has no working key: every provider is `no-key` or `rejected`, or there is no provider. A provider
 * that works, is unreachable, failed, or is `untested` (it has a credential or a sign-in whose models cannot be listed, or needs no key, as a local model server)
 * might work, so it counts as a key.
 * @param answer - the key test's answer, or undefined when it could not be read.
 * @returns true when the banner should show.
 */
export function hasNoWorkingKey(answer: KeyTestAnswer | undefined): boolean {
  if (answer === undefined) return false
  return answer.providers.every(each => each.result === 'no-key' || each.result === 'rejected')
}

/** What the banner says: nothing, that no key is saved, or that a saved key did not pass (with the provider's name). */
export type BannerState = { readonly kind: 'none' } | { readonly kind: 'add' } | { readonly kind: 'failed'; readonly name: string }

/**
 * @param answer - the key test's answer, or undefined when it could not be read.
 * @returns what the banner shows; a saved key that was refused outranks a missing one, and the official DeepSeek route comes first.
 */
export function bannerState(answer: KeyTestAnswer | undefined): BannerState {
  if (!hasNoWorkingKey(answer) || answer === undefined) return { kind: 'none' }
  const refused = answer.providers.filter(each => each.result === 'rejected')
  const shown = refused.find(each => each.provider === DEEPSEEK_ROUTE) ?? refused[0]
  return shown === undefined ? { kind: 'add' } : { kind: 'failed', name: shown.name }
}

/** The props of the banner in the input dock: this plugin's copy and the services. */
export type KeyBannerProps = PropsLocale<'delorunOnboarding'> & InjectFace<KeyBannerInjected>

/**
 * Render the banner while no key works.
 * @param props - this plugin's copy and the services.
 * @returns the banner, or nothing.
 */
export function KeyBanner({ t, keyTest, openModels }: KeyBannerProps): ReactNode {
  const [state, setState] = useState<BannerState>({ kind: 'none' })
  const missing = state.kind !== 'none'
  useEffect(() => {
    let current = true
    const check = (): void => { void keyTest().then((answer) => { if (current) setState(bannerState(answer)) }) }
    check()
    // Only a showing banner can change, and a key is added in another place, so the person coming back asks again.
    if (missing) window.addEventListener('focus', check)
    return () => {
      current = false
      window.removeEventListener('focus', check)
    }
  }, [keyTest, missing])
  if (!missing) return null
  return (
    <Alert
      kind="info"
      variant="banner"
      role="status"
      className={css.banner}
      title={state.kind === 'failed' ? t('keyBanner.failed', { name: state.name }) : t('keyBanner.text')}
      primary={{ label: t(state.kind === 'failed' ? 'keyBanner.check' : 'keyBanner.open'), onClick: openModels }}
    />
  )
}
