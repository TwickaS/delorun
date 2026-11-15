/**
 * The package-manager choice above the install command: a radio group that remembers the visitor's pick.
 *
 * @module @delorun/website/package-manager
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { COPY, DEFAULT_PACKAGE_MANAGER, PACKAGE_MANAGERS, type PackageManager } from '../site/copy.ts'

/** The `localStorage` key that holds the chosen package manager. */
export const PACKAGE_MANAGER_KEY = 'delorun.site.packageManager'

/**
 * Whether a stored value names a known package manager.
 * @param value - the stored text.
 * @returns whether it is one of the managers.
 */
function isPackageManager(value: string | null): value is PackageManager {
  return PACKAGE_MANAGERS.some(manager => manager === value)
}

/**
 * The chosen package manager. It starts as the default, so the server render and the first client render agree, and
 * takes the stored choice after mount. Choosing stores the pick; a blocked store keeps the choice for the visit.
 * @returns the manager and a setter that also stores it.
 */
export function usePackageManager(): readonly [PackageManager, (manager: PackageManager) => void] {
  const [manager, setManager] = useState<PackageManager>(DEFAULT_PACKAGE_MANAGER)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PACKAGE_MANAGER_KEY)
      if (isPackageManager(stored)) setManager(stored)
    } catch (error) {
      // Storage is blocked (private mode, policy); the default stays.
      void error
    }
  }, [])
  const choose = (next: PackageManager) => {
    setManager(next)
    try {
      localStorage.setItem(PACKAGE_MANAGER_KEY, next)
    } catch (error) {
      // Storage is blocked; the choice lasts until the page closes.
      void error
    }
  }
  return [manager, choose] as const
}

/**
 * A segmented radio group of package managers. Arrow keys move and select, Home and End jump, and only the selected
 * button is in the tab order.
 * @param props.value - the selected manager.
 * @param props.onChange - called with the manager the visitor picks.
 * @returns the group.
 */
export function PackageManagerPicker({ value, onChange }: { value: PackageManager, onChange: (manager: PackageManager) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const move = (event: KeyboardEvent, index: number) => {
    const last = PACKAGE_MANAGERS.length - 1
    const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : undefined
    if (target === undefined) return
    event.preventDefault()
    onChange(PACKAGE_MANAGERS[target]!)
    buttons.current[target]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={COPY.packageManagerLabel} className="flex rounded-lg border border-fd-border bg-fd-card p-0.5">
      {PACKAGE_MANAGERS.map((manager, index) => {
        const selected = manager === value
        return (
          <button
            key={manager}
            ref={element => { buttons.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(manager)}
            onKeyDown={event => move(event, index)}
            className={`min-w-16 flex-1 rounded-md px-3.5 py-1.5 font-mono text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-[4.5rem] ${selected ? 'bg-fd-foreground text-fd-background' : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground'}`}
          >
            {manager}
          </button>
        )
      })}
    </div>
  )
}
