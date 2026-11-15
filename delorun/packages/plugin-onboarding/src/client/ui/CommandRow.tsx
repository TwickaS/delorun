/**
 * A command to run in a terminal, with a button that copies it and says whether the copy worked.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { StepServices } from '../types.ts'
import css from './CommandRow.module.css'

/**
 * @param props - the command and this plugin's copy.
 * @returns the command row.
 */
export function CommandRow({ command, t }: { readonly command: string; readonly t: StepServices['t'] }): ReactNode {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const copy = (): void => {
    navigator.clipboard.writeText(command).then(() => { setCopied('yes') }, () => { setCopied('failed') })
  }
  return (
    <span className={css.row}>
      <code className={css.command}>{command}</code>
      <Button variant="outline" size="sm" className={css.copy} aria-label={t('copy.named', { command })} onClick={copy}>{t('copy')}</Button>
      <span className={css.status} aria-live="polite">{copied === 'yes' ? t('copy.done') : copied === 'failed' ? t('copy.failed') : ''}</span>
    </span>
  )
}
