/**
 * The install command: the package-manager choice above a code block with a copy button. With scripts off the choice
 * cannot work, so the page shows every manager's command as plain text instead.
 *
 * @module @delorun/website/install
 */
import { CodeBlock } from '@brand'
import { COPY, INSTALL_COMMANDS, PACKAGE_MANAGERS, type PackageManager } from '../site/copy.ts'
import { PackageManagerPicker } from './package-manager.tsx'

/** The class of the parts that need scripts; the scripts-off style in {@link ScriptsOff} hides them. */
export const NEEDS_SCRIPT = 'needs-script'

/** The class of the parts shown only with scripts off. */
const WITHOUT_SCRIPT = 'without-script'

/**
 * The style that swaps the scripted parts for their plain versions when scripts are off. A browser with scripts on
 * ignores what is inside `noscript`, so the swap costs the scripted page nothing.
 * @returns the style, once per page.
 */
export function ScriptsOff() {
  return (
    <noscript>
      <style>{`.${NEEDS_SCRIPT}{display:none!important}.${WITHOUT_SCRIPT}{display:block!important}`}</style>
    </noscript>
  )
}

/** The props of {@link CommandBlock}. */
interface CommandBlockProps {
  readonly command: string
  readonly size?: 'md' | 'lg'
  readonly className?: string
}

/**
 * One command in the brand's code block, with the site's copy wording.
 * @param props.command - the command.
 * @param props.size - `lg` at headline size, as the closing footer sets it.
 * @param props.className - extra classes.
 * @returns the block, whose copy button is the page's main button and so carries the accent.
 */
export function CommandBlock({ command, size = 'md', className }: CommandBlockProps) {
  const copy = COPY.hero
  return <CodeBlock code={command} copyLabel={copy.copyLabel} copiedLabel={copy.copiedLabel} failedLabel={copy.copyFailedLabel} size={size} emphasis="primary" className={className} />
}

/**
 * The install command with the package-manager choice.
 * @param props.manager - the chosen manager.
 * @param props.onChange - called with the manager the visitor picks.
 * @returns the block, and the plain list that replaces it with scripts off.
 */
export function Install({ manager, onChange }: { manager: PackageManager, onChange: (manager: PackageManager) => void }) {
  const copy = COPY.hero
  return (
    <div className="grid gap-3">
      <div className={`${NEEDS_SCRIPT} grid gap-3`}>
        <PackageManagerPicker value={manager} onChange={onChange} />
        <CommandBlock command={INSTALL_COMMANDS[manager]} />
      </div>
      <div className={`${WITHOUT_SCRIPT} hidden`}>
        <p className="mb-2 text-sm text-(--dl-text-muted)">{copy.commandsLabel}</p>
        <ul className="grid gap-2">
          {PACKAGE_MANAGERS.map(each => (
            <li key={each}><CommandBlock command={INSTALL_COMMANDS[each]} /></li>
          ))}
        </ul>
      </div>
    </div>
  )
}
