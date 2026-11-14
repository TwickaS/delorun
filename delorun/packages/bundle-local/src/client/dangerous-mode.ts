/**
 * Whether dangerous mode holds, as a remote studio's sections read it to offer the actions an unlocked device may take
 * instead of the notice that they need the computer. The mode is the `everywhere` answer of the permission routes.
 *
 * @module @delorun/bundle-local/client/dangerous-mode
 */
import { useEffect, useState } from 'react'
import { readEverywhere } from './consents-api.ts'
import type { HostFetch } from './host-api.ts'

/**
 * Read dangerous mode once when the section mounts.
 * @param fetch - the request function.
 * @returns whether the mode holds; false until the answer arrives and while the Host cannot be read.
 */
export function useDangerousMode(fetch: HostFetch): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let current = true
    void readEverywhere(fetch).then((answer) => { if (current) setOn(answer.on) })
    return () => { current = false }
  }, [fetch])
  return on
}
