/**
 * The row of one `rename_workspace` call: the old name, an arrow and the new one once the call settled, or the
 * refusal in the agent's words. It reads the call's recorded arguments and the result's persisted `from` and `to`, so a
 * replayed session shows what the live one did. Anything it cannot read falls back to the arguments, then to the call.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StartedToolCallViewProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ReactNode } from 'react'
import css from './RenameRow.module.css'

/** The props of the row: the toolview's payload and this plugin's copy. */
export type RenameRowProps = ToolCallViewProps & PropsLocale<'delorunOnboarding'>

/** What the row shows once it has read the call. */
export type RenameModel =
  | { readonly state: 'running'; readonly target: string }
  | { readonly state: 'renamed'; readonly from: string; readonly to: string }
  | { readonly state: 'same'; readonly to: string }
  | { readonly state: 'refused'; readonly target: string; readonly reason: string }

/**
 * Read a string field of a JSON object.
 * @param value - parsed JSON.
 * @param key - the field.
 * @returns the field when it is a string, otherwise undefined.
 */
function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

/**
 * Parse the call's recorded arguments, which a streaming call may hold only in part.
 * @param raw - the arguments as JSON text.
 * @returns the arguments, or undefined when they do not parse.
 */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Streaming exposes a truncated prefix; the row then shows the call without the names.
    return undefined
  }
}

/**
 * Derive what the row shows from the durable call slice only.
 * @param block - the call as the conversation holds it.
 * @returns the row's model.
 */
export function renameModel(block: StartedToolCallViewProps['block']): RenameModel {
  const settled = 'kind' in block
  const args = parseArgs((settled ? block.call?.argsRaw : block.argsRaw) ?? '')
  const target = field(args, 'workspace') ?? ''
  if (!settled) return { state: 'running', target }
  if (block.isError) {
    const text = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
    return { state: 'refused', target, reason: text || (block.error === undefined ? '' : block.error.code) }
  }
  const from = field(block.meta, 'from')
  const to = field(block.meta, 'to')
  if (to === undefined) return { state: 'running', target }
  return from === undefined || from === to ? { state: 'same', to } : { state: 'renamed', from, to }
}

/**
 * Render one `rename_workspace` call.
 * @param props - the toolview payload and this plugin's copy.
 * @returns the row.
 */
export function RenameRow(props: RenameRowProps): ReactNode {
  const { t } = props
  const title = <span className={css.title}>{t('rename.title')}</span>
  if (props.phase === 'preparing') return <div className={css.row} data-tool="rename_workspace" data-state="preparing">{title}</div>
  const model = renameModel(props.block)
  switch (model.state) {
    case 'running':
      return <div className={css.row} data-tool="rename_workspace" data-state="running">{title}<span className={css.name}>{model.target}</span></div>
    case 'renamed':
      return (
        <div className={css.row} data-tool="rename_workspace" data-state="ok">
          {title}
          <span className={css.name}>{model.from}</span>
          <span className={css.arrow} aria-label={t('rename.to')}>→</span>
          <span className={css.name}>{model.to}</span>
        </div>
      )
    case 'same':
      return <div className={css.row} data-tool="rename_workspace" data-state="ok">{title}<span className={css.name}>{t('rename.same', { name: model.to })}</span></div>
    case 'refused':
      return (
        <div className={css.row} data-tool="rename_workspace" data-state="error">
          {title}
          <span className={css.name}>{model.target}</span>
          <span className={css.refusal} role="status">{t('rename.refused', { reason: model.reason })}</span>
        </div>
      )
    /* v8 ignore next 2 -- closed-union default only defends a future widening of RenameModel */
    default: return assertNever(model)
  }
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when RenameModel widens without this switch */
function assertNever(value: never): never {
  throw new Error(`unhandled rename row state ${JSON.stringify(value)}`)
}
