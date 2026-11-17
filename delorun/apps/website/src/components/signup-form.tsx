/**
 * The sign-up form. It posts to the Worker, which verifies a Turnstile token before it stores anything. The Turnstile
 * script loads from Cloudflare only when the visitor first uses the form, so a page that is only read loads nothing
 * from another host. Without scripts the form cannot pass the check; the note says so and names the email address.
 *
 * @module @delorun/website/signup-form
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, Link, TextField } from '@brand'
import { SUPPORT_EMAIL } from '@/site/config.ts'
import { SIGNUP_EN } from '@/site/words/signup-en.ts'
import { CONSENT_TEXT, FIELDS, MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, SIGNUP_CONFIG_PATH, SUBSCRIBE_PATH } from '@/site/signup.ts'

/** The part of Turnstile's script API the form calls. */
interface TurnstileApi {
  render(container: HTMLElement, options: { sitekey: string; appearance: 'interaction-only'; callback: (token: string) => void; 'error-callback': () => void; 'expired-callback': () => void }): string
  reset(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** Where Cloudflare serves the Turnstile script, loaded as its documentation shows. */
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** What the form shows below the button. */
type Status = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; text: string }

/**
 * Loads Turnstile's script once.
 * @returns the script's API, once it has loaded.
 */
function loadTurnstile(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    if (window.turnstile !== undefined) return resolve(window.turnstile)
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT
    script.async = true
    script.onload = () => window.turnstile === undefined ? reject(new Error('Turnstile did not load')) : resolve(window.turnstile)
    script.onerror = () => reject(new Error('Turnstile did not load'))
    document.head.append(script)
  })
}

/**
 * The form.
 * @param props.page - the path of the page that carries it, which the sign-up records as the place of consent.
 * @param props.compact - true in the footer, where the form is laid out as a row on wide screens.
 * @returns the form.
 */
export function SignupForm({ page, compact = false }: { page: string; compact?: boolean }) {
  const copy = SIGNUP_EN
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const token = useRef<string | null>(null)
  const submitWhenReady = useRef(false)
  const starting = useRef(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  /** Posts the form with the token the widget produced. */
  async function send(): Promise<void> {
    const form = formRef.current
    if (form === null) return
    const body = new FormData(form)
    body.set(FIELDS.turnstile, token.current ?? '')
    setStatus({ kind: 'working', text: copy.sending })
    try {
      const response = await fetch(SUBSCRIBE_PATH, { method: 'POST', body, headers: { Accept: 'application/json' } })
      const result: { ok: boolean; message: string } = await response.json()
      setStatus({ kind: result.ok ? 'done' : 'error', text: result.message })
      if (result.ok) form.reset()
    } catch {
      setStatus({ kind: 'error', text: copy.networkError })
    }
    token.current = null
    if (widgetId.current !== null) window.turnstile?.reset(widgetId.current)
  }

  /** Starts the check the first time the visitor uses the form. */
  async function start(): Promise<void> {
    if (starting.current || widgetRef.current === null) return
    starting.current = true
    try {
      const [api, config] = await Promise.all([loadTurnstile(), fetch(SIGNUP_CONFIG_PATH).then(response => response.json() as Promise<{ siteKey: string }>)])
      if (widgetRef.current === null) return
      widgetId.current = api.render(widgetRef.current, {
        sitekey: config.siteKey,
        appearance: 'interaction-only',
        callback: value => {
          token.current = value
          if (submitWhenReady.current) {
            submitWhenReady.current = false
            void send()
          }
        },
        'error-callback': () => setStatus({ kind: 'error', text: copy.checkError }),
        'expired-callback': () => { token.current = null },
      })
    } catch {
      starting.current = false
      setStatus({ kind: 'error', text: copy.checkError })
    }
  }

  useEffect(() => {
    const form = formRef.current
    form?.addEventListener('focusin', start, { once: true })
    return () => form?.removeEventListener('focusin', start)
  }, [])

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (token.current !== null) return void send()
    submitWhenReady.current = true
    setStatus({ kind: 'working', text: copy.checking })
    void start()
  }

  return (
    <form ref={formRef} method="post" action={SUBSCRIBE_PATH} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name={FIELDS.page} value={page} />
      <div className={compact ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-4 sm:grid-cols-[1fr_1.4fr]'}>
        <TextField label={`${copy.nameLabel} ${copy.optional}`} name={FIELDS.firstName} type="text" autoComplete="given-name" maxLength={MAX_NAME_LENGTH} />
        <TextField label={copy.emailLabel} name={FIELDS.email} type="email" required autoComplete="email" inputMode="email" maxLength={MAX_EMAIL_LENGTH} />
      </div>
      <div className="flex items-start gap-3">
        <input id={`${id}-consent`} name={FIELDS.consent} type="checkbox" value="yes" required className="mt-1 size-5 shrink-0 accent-(--dl-text)" />
        <label htmlFor={`${id}-consent`} className="text-sm leading-6">{CONSENT_TEXT}</label>
      </div>
      <div ref={widgetRef} />
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="secondary" disabled={status.kind === 'working'}>{copy.submit}</Button>
        <p className="text-sm text-(--dl-text-muted)">{copy.privacyNote.before}<Link href="/privacy#updates">{copy.privacyNote.link}</Link>{copy.privacyNote.after}</p>
      </div>
      <p role="status" aria-live="polite" className={`text-sm font-medium ${status.kind === 'error' ? 'text-(--dl-error)' : ''}`}>{status.kind === 'idle' ? '' : status.text}</p>
      <noscript><p className="text-sm text-(--dl-text-muted)">{copy.noScript(SUPPORT_EMAIL)}</p></noscript>
    </form>
  )
}
