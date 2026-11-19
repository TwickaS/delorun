/**
 * The home page's sign-up section.
 *
 * @module @delorun/website/signup-section
 */
import { SECTIONS_EN } from '@/site/words/sections-en.ts'
import { HOME_SIGNUP_PAGE } from '@/site/signup.ts'
import { GRID, SPACE } from '@/components/grid.ts'
import { SignupForm } from '@/components/signup.tsx'

/**
 * The home page's sign-up section, on the page grid: the heading and its sentence from column 1, the form from column 5.
 * The form records `/` as the place of consent, which the Worker's list of sign-up pages names.
 * @returns the section.
 */
export function SignupSection() {
  const copy = SECTIONS_EN.signup
  return (
    <section aria-labelledby="updates" className={`${GRID} ${SPACE.normal}`}>
      <div className="col-span-full border-t border-(--dl-border) pt-8 lg:col-span-4">
        <h2 id="updates" className="text-2xl font-semibold tracking-tight">{copy.heading}</h2>
        <p className="mt-3 max-w-sm leading-7 text-(--dl-text-muted)">{copy.text}</p>
      </div>
      <div className="col-span-full mt-8 lg:col-start-5 lg:col-end-12 lg:mt-0 lg:border-t lg:border-(--dl-border) lg:pt-8">
        <SignupForm page={HOME_SIGNUP_PAGE} />
      </div>
    </section>
  )
}
