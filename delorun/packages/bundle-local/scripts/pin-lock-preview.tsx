/**
 * Entry of the bundle that `pin-screens.ts` injects into the running studio page: it mounts the real {@link PinLock} over
 * the page with a fixed view, so the screenshot carries the studio's own theme, fonts and icons.
 * @module @delorun/bundle-local/scripts/pin-lock-preview
 */
import { createRoot } from 'react-dom/client'
import { PinLock, type PinLockProps } from '../src/client/PinLock.tsx'
import { en, type PinLocaleKey } from '../src/client/pin-locales.ts'
import type { PinView } from '../src/client/pin-lock.ts'

const t = ((key: PinLocaleKey, values?: Record<string, string>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')) as PinLockProps['t']

/**
 * Mount the lock screen over the page.
 * @param view - what the store would report.
 */
function mountPinLock(view: PinView): void {
  const host = document.createElement('div')
  document.body.append(host)
  const usePin = ((select: (current: PinView) => unknown) => select(view)) as PinLockProps['usePin']
  createRoot(host).render(<PinLock t={t} usePin={usePin} unlock={async () => {}} />)
}

Object.assign(globalThis, { mountPinLock })
