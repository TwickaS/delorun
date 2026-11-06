/**
 * The DeepSeek account's notices and sign-in dialog, in `shell.overlay` so they
 * show under any sidebar launcher: a toast when a model needs the account and
 * when the account's session expires, and the sign-in dialog while sign-in runs.
 */
import { useEffect, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignInDialog } from './SignInDialog.tsx'

/** The account face plus the Settings navigation the dialog's API-key choice uses. */
export type AccountOverlayInjected = AccountSectionInjected & {
  /** Open one Settings onboarding step, as `ctx.settingsShell.openOnboarding` does. */
  openOnboarding: (id: string) => void
}

/** Overlay props: the shell overlay seat, the account copy and the account face. */
export type AccountOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<AccountOverlayInjected>

/**
 * Render the account's toasts and its sign-in dialog.
 * @param props - the account face and copy.
 * @returns the overlay content.
 */
export function AccountOverlay({
  subscribeSessionExpired, subscribeModelSignInRequired, useAccount, useTheme, start, cancel, showLogin, openOnboarding, t,
}: AccountOverlayProps) {
  const account = useAccount(state => state)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const [signInNotice, setSignInNotice] = useState(0)
  useEffect(() => subscribeModelSignInRequired?.(() => { setSignInNotice(value => value + 1) }), [subscribeModelSignInRequired])
  const [expiryNotice, setExpiryNotice] = useState(false)
  useEffect(() => subscribeSessionExpired?.(() => { setExpiryNotice(true) }), [subscribeSessionExpired])
  return <>
    {signInNotice > 0 && <Toast key={signInNotice} text={t('modelSignInRequired')} onDone={() => { setSignInNotice(0) }} />}
    {expiryNotice && <Toast text={t('sessionExpired')} onDone={() => { setExpiryNotice(false) }} />}
    {account.loginVisible && !account.onboarding && <SignInDialog account={account} colorScheme={colorScheme}
      start={start} cancel={cancel} t={t}
      close={() => { showLogin(false) }} useApiKey={() => { showLogin(false); openOnboarding('deepseek-official') }} />}
  </>
}
