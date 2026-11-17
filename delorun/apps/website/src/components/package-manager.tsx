/**
 * The package-manager choice above the install command: a segmented radio group that remembers the visitor's pick.
 *
 * @module @delorun/website/package-manager
 */
import { useEffect, useState } from 'react'
import { ChoiceGroup } from '@brand'
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
 * Removes the stored choice, so the page shows the default again on the next visit.
 * @returns whether the store could be reached; false where storage is blocked, which also means nothing was kept.
 */
export function forgetPackageManager(): boolean {
  try {
    localStorage.removeItem(PACKAGE_MANAGER_KEY)
    return true
  } catch (error) {
    // Storage is blocked (private mode, policy), so no choice was kept in it.
    void error
    return false
  }
}

/**
 * The package managers as brand's segmented radio group, filling the width of the install box below it: arrow keys move
 * and select, Home and End jump, and only the selected segment is in the tab order.
 * @param props.value - the selected manager.
 * @param props.onChange - called with the manager the visitor picks.
 * @returns the group.
 */
export function PackageManagerPicker({ value, onChange }: { value: PackageManager, onChange: (manager: PackageManager) => void }) {
  return (
    <ChoiceGroup
      label={COPY.hero.packageManagerLabel}
      value={value}
      options={PACKAGE_MANAGERS.map(manager => ({ value: manager, label: manager }))}
      onChange={onChange}
      disabled={false}
      fill
      mono
    />
  )
}
