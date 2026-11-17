/** The control that stands where the Plugins page's enable switch is, for a plugin pack that is not downloaded yet. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Translate } from './locales.ts'
import { nameOf, PACK_TITLE_KEYS } from './names.ts'
import { statusText } from './Items.tsx'
import { useHubSource } from './Phone.tsx'
import { isActive } from './source.ts'

/**
 * The routing decision of the chain entry: the page's own switch stands unless the subject is a pack of this release
 * that is not in the home. Pure in the subject, as a chain selector must be.
 * @param subject - what the card or page is about.
 * @returns the package name the entry acts for, or `null` to leave the switch.
 */
export function packToAdd(subject: PluginsSubject): string | null {
  if (subject.kind !== 'bundle') return null
  const { pkg } = subject
  return Object.hasOwn(PACK_TITLE_KEYS, pkg.name) && pkg.availability === 'missing' && !pkg.installed ? pkg.name : null
}

/**
 * Add the pack, then show where its install stands.
 * @param props - the package this entry acts for and the copy.
 * @returns the button, or the queue state once the pack is in the install list.
 */
export function PackAddAction({ matched, t }: { readonly matched: string, readonly t: Translate }): ReactNode {
  const source = useHubSource()
  const items = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const item = items.find(each => each.key === matched)
  const name = nameOf({ key: matched }, t)
  if (item === undefined || item.state === 'cancelled') {
    return <Button variant="outline" size="sm" aria-label={t('addItem', { name })} onClick={() => { source.enqueue(matched) }}>{t('add')}</Button>
  }
  if (item.state === 'failed') {
    return (
      <span role="status">
        <span>{statusText(item, t)}</span>
        {' '}
        <Button variant="outline" size="sm" aria-label={t('retryItem', { name })} onClick={() => { source.retry(matched) }}>{t('retry')}</Button>
      </span>
    )
  }
  return <span role="status">{isActive(item) ? statusText(item, t) : t('added')}</span>
}
