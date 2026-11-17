/**
 * A compact search field for the product site's header. It is a plain GET form to the documentation site's
 * `?search=<query>` address, so it works with scripts off; once scripts run it also carries the visitor's look as hidden
 * fields, since a GET form replaces the query of its action. The documentation's search index is not loaded here.
 *
 * @module @delorun/site-design/search-form
 */
import { TextField } from '../../brand/src/components/TextField.tsx'
import { useLook } from './look-store.ts'
import { lookQuery } from './looks.ts'

/** The text of the field. */
export interface SearchCopy {
  /** The field's accessible name. */
  readonly label: string
  /** The placeholder. */
  readonly placeholder: string
}

/**
 * The search form.
 * @param props.action - the documentation site's address.
 * @param props.copy - the field's text.
 * @param props.className - classes for the form, which decide the widths it shows at.
 * @returns the form.
 */
export function SearchForm({ action, copy, className }: { action: string; copy: SearchCopy; className?: string | undefined }) {
  const carried = [...new URLSearchParams(lookQuery(useLook()))]
  return (
    <form action={action} method="get" role="search" className={className}>
      <TextField label={copy.label} hideLabel type="search" name="search" placeholder={copy.placeholder} autoComplete="off" required />
      {carried.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    </form>
  )
}
