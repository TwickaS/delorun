/**
 * The "Unlocked · 14 min" chip of a live Face ID pass (A499), with Lock now. It sits in `conversation.session.banner`,
 * above the open chat on a phone and on a desktop device, counts down in whole minutes (rounded up) and disappears when
 * the pass ends. The home's own computer has no pass, so it never shows there.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PassSource } from './face-id-pass.ts'
import css from './FacePassChip.module.css'

/** How often the chip moves its count: every 15 seconds. */
export const CHIP_TICK_MS = 15_000

/** What the plugin supplies the chip. */
export interface FacePassChipInjected {
  /** The page's pass mirror. */
  readonly hooks: PassSource['hooks']
  /** Ends this device's pass. */
  readonly lockNow: PassSource['lockNow']
  /** The clock; `Date.now` by default. */
  readonly now?: () => number
}

/** Props the renderer binds for the chip. */
export type FacePassChipProps = PropsLocale<'delorunFaceId'> & InjectFace<FacePassChipInjected>

/**
 * Render the chip.
 * @param props - the copy, the pass and Lock now.
 * @returns the chip while a pass is live; otherwise nothing.
 */
export function FacePassChip({ t, usePass, lockNow, now = Date.now }: FacePassChipProps): ReactNode {
  const endsAt = usePass(state => state.endsAt)
  const [at, setAt] = useState(now)
  const [locking, setLocking] = useState(false)
  useEffect(() => {
    if (endsAt === null) return
    setAt(now())
    const timer = setInterval(() => { setAt(now()) }, CHIP_TICK_MS)
    return () => { clearInterval(timer) }
  }, [endsAt, now])
  if (endsAt === null || endsAt <= at) return null
  const minutes = String(Math.max(1, Math.ceil((endsAt - at) / 60_000)))
  return (
    <div className={css.chip} role="status" aria-label={t('pass.chipLabel', { minutes })} data-delorun-face-pass="">
      <span className={css.dot} aria-hidden />
      <span className={css.text}>{t('pass.chip', { minutes })}</span>
      <button type="button" className={css.lock} disabled={locking} data-delorun-face-pass-lock=""
        onClick={() => { setLocking(true); void lockNow().finally(() => { setLocking(false) }) }}>
        {t('pass.lockNow')}
      </button>
    </div>
  )
}
