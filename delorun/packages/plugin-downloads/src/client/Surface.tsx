/** The one frame-wide overlay entry: the card on a computer, the header icon and sheet on a phone, drawn in the document body. */
import { usePhone } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DownloadsCard } from './Card.tsx'
import { DownloadsSheet, useHubSource } from './Phone.tsx'
import type { Translate } from './locales.ts'
import { useDownloadsModel } from './model.ts'
import { onboardingRowShown, subscribeHub } from './source.ts'

/**
 * @param props - the translate of the slot machinery.
 * @returns the presentation that fits the window.
 */
export function DownloadsSurface({ t }: { readonly t: Translate }): ReactNode {
  const source = useHubSource()
  const model = useDownloadsModel(source)
  const phone = usePhone()
  const rowShown = useSyncExternalStore(subscribeHub, onboardingRowShown, onboardingRowShown)
  // While the setup guide shows its own row, the phone's icon stays out of the way.
  // Portalled to the body: the setup guide makes the page root inert, and the card must stay usable beside it.
  const surface = phone
    ? (rowShown ? null : <DownloadsSheet model={model} source={source} t={t} />)
    : <DownloadsCard model={model} source={source} t={t} />
  return createPortal(surface, document.body)
}
