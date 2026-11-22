/**
 * The download size, speed and time-left formats and the windowed speed of `@delorun/install/transfer`, for the studio
 * surfaces that show a pack's download: the downloads panel and the setup guide reach the install path through this
 * package. It imports nothing else, so a client bundle may import it.
 *
 * @module @delorun/plugin-packs/transfer
 */
export { formatRemaining, formatSize, formatSpeed, STALL_SHOWN_MS, TransferRate } from '@delorun/install/transfer'
