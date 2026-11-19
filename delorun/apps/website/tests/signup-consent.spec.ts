// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { answerText, SignupForm } from '../src/components/signup-form.tsx'
import { FIELDS } from '../src/site/signup.ts'
import { CONSENT_OUT_OF_DATE, CONSENT_TEXT, CONSENT_TEXT_VERSION, CONSENTS } from '../src/site/words/consent-en.ts'

/** Every consent sentence that has been published, as it was published. A published entry never changes. */
const PUBLISHED: Readonly<Record<string, string>> = {
  '1': 'Email me Delorun release news. One click unsubscribes.',
  '2': 'Email me Delorun release news and major articles. One click unsubscribes.',
}

describe('the sign-up consent', () => {
  it('keeps every published sentence under its version, so a changed wording needs a new version', () => {
    for (const [version, sentence] of Object.entries(PUBLISHED)) expect(CONSENTS[version as keyof typeof CONSENTS], `version ${version}`).toBe(sentence)
    expect(CONSENT_TEXT).toBe(CONSENTS[CONSENT_TEXT_VERSION])
  })

  it('gives each version its own sentence', () => {
    const sentences = Object.values(CONSENTS)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('is posted by the form with the version of the sentence the form shows', () => {
    const html = renderToStaticMarkup(createElement(SignupForm, { page: '/' }))
    const form = new DOMParser().parseFromString(html, 'text/html').body.querySelector('form')!
    const version = form.querySelector<HTMLInputElement>(`input[type="hidden"][name="${FIELDS.consentVersion}"]`)!.value
    const box = form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${FIELDS.consent}"]`)!
    expect(form.ownerDocument.querySelector(`label[for="${box.id}"]`)!.textContent).toBe(CONSENTS[version as keyof typeof CONSENTS])
  })

  it('asks the visitor to reload when the Worker refuses an out-of-date page', () => {
    expect(answerText({ ok: false, message: 'Worker text', code: 'out_of_date' })).toBe(CONSENT_OUT_OF_DATE)
    expect(answerText({ ok: false, message: 'Worker text' })).toBe('Worker text')
    expect(CONSENT_OUT_OF_DATE).toMatch(/Reload the page/)
  })
})
