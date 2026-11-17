/** The control that stands where the Plugins page's enable switch is, for a plugin pack that is not downloaded yet. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Translate } from './locales.ts'
import { nameOf, PACK_TITLE_KEYS } from './names.ts'
import { statusText } from './Items.tsx'
import { useHubSource } from './Phone.tsx'
import { currentDownloadsSource, isActive, providedUninstall } from './source.ts'

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

/**
 * The routing decision of the second chain entry: a pack that is in the home but whose last install failed, such as one
 * whose plugins would not load. The page would draw its switch and say "installed" while the queue says it failed; this
 * entry stands there instead, with the reason. It reads the queue as it is when the page draws, and the page draws again
 * on the install announcement that ends the failed install.
 * @param subject - what the card or page is about.
 * @returns the package name the entry acts for, or `null` to leave the switch.
 */
export function packNotLoading(subject: PluginsSubject): string | null {
  if (subject.kind !== 'bundle') return null
  const { pkg } = subject
  if (!Object.hasOwn(PACK_TITLE_KEYS, pkg.name) || !pkg.installed) return null
  return currentDownloadsSource().snapshot().some(item => item.key === pkg.name && item.state === 'failed') ? pkg.name : null
}

/**
 * Say that the pack is installed but not loading, with the reason, and offer Try again and Remove. Remove uninstalls the
 * pack through the plugin manager, as the Plugins page does under the same permission rules, and then clears the failed
 * record; if the removal does not happen the record stays and the card says so.
 * @param props - the package this entry acts for and the copy.
 * @returns the failure and its two controls, the install's progress after Try again, or nothing when the failure was cleared.
 */
export function PackNotLoadingAction({ matched, t }: { readonly matched: string, readonly t: Translate }): ReactNode {
  const source = useHubSource()
  const items = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
  const [removal, setRemoval] = useState<'idle' | 'removing' | 'refused'>('idle')
  const item = items.find(each => each.key === matched)
  if (item === undefined) return null
  const name = nameOf({ key: matched }, t)
  // After Try again the item is queued or working until the page draws again: say where it stands, never a blank.
  if (isActive(item)) return <span role="status">{statusText(item, t)}</span>
  if (item.state !== 'failed') return null
  const remove = (): void => {
    const uninstall = providedUninstall()
    setRemoval('removing')
    void (uninstall === undefined ? Promise.reject(new Error('no uninstall')) : uninstall(matched)).then(
      () => { source.remove(matched) },
      () => { setRemoval('refused') },
    )
  }
  return (
    <span role="status">
      <span>{t('notLoading', { reason: statusText(item, t) })}</span>
      {removal === 'refused' && <span>{' '}{t('notRemoved')}</span>}
      {' '}
      <Button variant="outline" size="sm" aria-label={t('retryItem', { name })} onClick={() => { source.retry(matched) }}>{t('retry')}</Button>
      {' '}
      <Button variant="outline" size="sm" disabled={removal === 'removing'} aria-label={t('uninstallItem', { name })} onClick={remove}>{t('remove')}</Button>
    </span>
  )
}
