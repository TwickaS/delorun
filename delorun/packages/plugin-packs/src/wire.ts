/**
 * The wire types of the `packs` remote and its `packs/queue` event: what the downloads panel, Plugins and onboarding
 * read and send. This file imports no Cordis, so a client bundle may import it.
 *
 * @module @delorun/plugin-packs/wire
 */
import type { InstallFailure, InstallItem } from '@delorun/install-queue'

export type { InstallFailure, InstallItem, InstallState } from '@delorun/install-queue'

/**
 * The request id a pack's install is announced under on `plugin-manager/install-state`.
 * @param name - the package name.
 * @returns `pack:<name>`.
 */
export function packRequestId(name: string): string {
  return `pack:${name}`
}

/** Where one pack stands apart from the queue. */
export type PackAvailability = 'available' | 'installed' | 'unavailable'

/** One pack the installed release publishes. */
export interface PackInfo {
  /** The package name. */
  readonly name: string
  /** The pack's version. */
  readonly version: string
  /** Whether Plugins labels it experimental. */
  readonly experimental: boolean
  /** Bytes the download takes on this computer: the archive and its external packages. */
  readonly downloadBytes: number
  /** `installed` once its files are in the home for this release; `unavailable` when the release publishes it for no variant of this platform. */
  readonly availability: PackAvailability
  /** Why the pack is `unavailable`. */
  readonly reason?: string
}

/** Everything a surface draws, as `packs/list` returns it and `packs/queue` carries it. */
export interface PacksSnapshot {
  /** False when this Host has no installed release to take packs from (a source checkout, or a release without a packs file). */
  readonly supported: boolean
  /** Why `supported` is false. */
  readonly reason?: string
  /** The installed release's version. */
  readonly release?: string
  /** The packs the release publishes. */
  readonly packs: readonly PackInfo[]
  /** The install list, in queue order. */
  readonly queue: readonly InstallItem[]
}

/** A request that names packs. */
export interface PacksNamesRequest {
  /** Package names. */
  readonly names: readonly string[]
}

/** A request that names one pack. */
export interface PacksNameRequest {
  /** The package name. */
  readonly name: string
}

/**
 * The Host's routes for the packs, each `POST` with a JSON body, answering a {@link PacksResult} (`packs/list` answers a
 * {@link PacksSnapshot}). The studio fetches each without its leading `/`, relative to the document. A device without an
 * unlock is answered `403` on the routes that need one.
 */
export const PACK_ROUTES = {
  /** `{}` → {@link PacksSnapshot}. Any approved device. */
  list: '/api/delorunPacks.list',
  /** `{ names }` → {@link PacksResult}. Needs the computer, or a device's unlock. */
  enqueue: '/api/delorunPacks.enqueue',
  /** `{ name }` → {@link PacksResult}: stops a queued or working install. Any approved device. */
  cancel: '/api/delorunPacks.cancel',
  /** `{ name }` → {@link PacksResult}: clears a failed or cancelled row. Any approved device. */
  dismiss: '/api/delorunPacks.dismiss',
  /** `{ name }` → {@link PacksResult}. Needs the computer, or a device's unlock. */
  retry: '/api/delorunPacks.retry',
  /** `{ name }` → {@link PacksResult}. Needs the computer, or a device's unlock. */
  remove: '/api/delorunPacks.remove',
} as const

/** The routes a device reaches only while it holds an unlock. */
export const PACK_ELEVATED_ROUTES: readonly string[] = [PACK_ROUTES.enqueue, PACK_ROUTES.retry, PACK_ROUTES.remove]

/** The error codes of the `packs` remote. */
export type PacksErrorCode = 'unsupported' | 'unknown-pack' | 'unavailable-pack'

/** A remote result: the new snapshot, or why nothing happened. */
export type PacksResult = { readonly ok: true, readonly value: PacksSnapshot } | { readonly ok: false, readonly error: { readonly code: PacksErrorCode, readonly message: string } }

/** The remote's actions that a phone may take only while unlocked (contract C14, "Elevation"). */
export const PACKS_ELEVATED_ACTIONS = ['packs/enqueue', 'packs/remove', 'packs/retry'] as const

/** The remote's actions a locked phone may take: reading, cancelling an install, which only stops one, and clearing a failed or cancelled row, which only clears a record (A408). */
export const PACKS_READ_ACTIONS = ['packs/list', 'packs/cancel', 'packs/dismiss'] as const

/** How a surface draws one pack. */
export type PackView =
  | { readonly kind: 'available' }
  | { readonly kind: 'working', readonly item: InstallItem }
  | { readonly kind: 'restart', readonly item: InstallItem }
  | { readonly kind: 'installed' }
  | { readonly kind: 'offline', readonly message: string }
  | { readonly kind: 'failed', readonly failure: InstallFailure }
  | { readonly kind: 'unavailable', readonly reason: string }

/**
 * Where one pack stands for a surface: the queue item wins over the pack's availability.
 * @param pack - the pack, or `undefined` when the release publishes none by that name.
 * @param item - the pack's queue item, when it has one.
 * @returns the view.
 */
export function packView(pack: PackInfo | undefined, item: InstallItem | undefined): PackView {
  if (pack === undefined) return { kind: 'unavailable', reason: 'This release has no such plugin pack.' }
  if (item !== undefined) {
    switch (item.state) {
      case 'queued': case 'downloading': case 'verifying': case 'installing': return { kind: 'working', item }
      case 'needs-reload': return { kind: 'restart', item }
      case 'ready': return { kind: 'installed' }
      case 'failed': return item.failure?.code === 'offline' ? { kind: 'offline', message: item.failure.message } : { kind: 'failed', failure: item.failure ?? { code: 'failed', message: 'The install failed.' } }
      case 'cancelled': break
    }
  }
  if (pack.availability === 'unavailable') return { kind: 'unavailable', reason: pack.reason ?? 'This plugin is not published for this computer.' }
  return pack.availability === 'installed' ? { kind: 'installed' } : { kind: 'available' }
}
