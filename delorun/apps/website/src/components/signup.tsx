/**
 * The sign-up form as the pages place it. The form's script and words are a chunk of their own, which the browser loads
 * after the first screen; the server renders the form in full, and React keeps that markup until the chunk arrives.
 *
 * @module @delorun/website/signup
 */
import { lazy, Suspense } from 'react'

// The server imports the form before it renders, so every prerendered page holds it in full and never a fallback.
const form = import.meta.env.SSR ? await import('@/components/signup-form.tsx') : undefined
const LazyForm = form?.SignupForm ?? lazy(() => import('@/components/signup-form.tsx').then(module => ({ default: module.SignupForm })))

/**
 * The form.
 * @param props.page - the path of the page that carries it, which the sign-up records as the place of consent.
 * @param props.compact - true in the footer, where the form is laid out as a row on wide screens.
 * @returns the form.
 */
export function SignupForm({ page, compact = false }: { page: string; compact?: boolean }) {
  return <Suspense fallback={null}><LazyForm page={page} compact={compact} /></Suspense>
}
