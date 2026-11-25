/**
 * The URL a preview hands `new Worker` for a Worker built from a Blob.
 *
 * A page under a reach listener's Content Security Policy enforces Trusted
 * Types for script, so the `Worker` constructor refuses a plain string and
 * accepts only a `TrustedScriptURL`. The page boot creates the
 * `delorun-blob-worker` policy, which admits a `blob:` URL whose origin is the
 * page's own; this module reads that policy from the `__DSH_TRUSTED_TYPES__`
 * page global, as the client module loader reads `delorun-plugin-loader`. A
 * page whose boot created no policy (a browser without Trusted Types, or the
 * loopback studio, which sends no Content Security Policy) gets the raw URL,
 * which its constructor accepts.
 *
 * @module @deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/worker-script-url
 */

/** The page boot's Trusted Types stash, read structurally. */
interface BlobWorkerStash {
  readonly blobWorker?: { createScriptURL(input: string): string | null }
}

/**
 * Mint the Worker URL through the page's `delorun-blob-worker` policy.
 * @param url - the `blob:` URL this page created for its Worker source.
 * @returns the URL the `Worker` constructor accepts.
 * @throws Error when the policy refuses the URL, so the constructor is never reached.
 */
export function workerScriptUrl(url: string): string {
  const policy = (globalThis as { __DSH_TRUSTED_TYPES__?: BlobWorkerStash }).__DSH_TRUSTED_TYPES__?.blobWorker
  if (policy === undefined) return url
  const trusted = policy.createScriptURL(url)
  if (trusted === null) throw new Error(`document preview: Worker URL ${url} refused by the delorun-blob-worker policy`)
  return trusted
}
