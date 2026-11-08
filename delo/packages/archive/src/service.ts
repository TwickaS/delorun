/**
 * The registration of the archive service on a Cordis context. The
 * registration is one `ctx.effect` call, so it ends when the context is
 * disposed, and it returns a handle whose `dispose` ends it early. A disposed
 * service refuses an import before it stages anything, so a teardown never
 * leaves a half-published archive behind.
 *
 * @module @delo/archive/service
 */
import { ArchiveImporter, type ArchiveImportReport, type ArchiveImporterConfig } from './importer.ts'
import { exportArchive, type ArchiveExportInput, type ArchiveExportResult } from './exporter.ts'
import { ArchiveError } from './errors.ts'

/**
 * The slice of a Cordis context the registration uses. It is structural, so
 * the package keeps no dependency on the Cordis runtime and a context object
 * satisfies it without an adapter.
 */
export interface ArchiveContext {
  /**
   * Register one effect, which ends when the context is disposed.
   * @param body - the effect, which returns its own disposer.
   * @param label - the effect's name in the context's diagnostics.
   * @returns the disposer that ends the effect early.
   */
  effect(body: () => () => void, label: string): () => void
}

/** What a registration gives back. */
export interface ArchiveHandle {
  /** The service the registration attached. */
  readonly service: ArchiveService
  /** The disposer that ends the registration, which the context also calls when it is disposed. */
  readonly dispose: () => void
}

/**
 * The archive service one home runs: the import path and the export path.
 */
export class ArchiveService {
  private readonly importer: ArchiveImporter
  private readonly lifetime = new AbortController()
  private disposed = false

  /**
   * @param config - the staging parent, the workspace store and the keys the home vouches for.
   */
  constructor(config: ArchiveImporterConfig) {
    this.importer = new ArchiveImporter(config)
  }

  /**
   * Validate one archive and publish its workspaces.
   * @param bytes - the whole archive.
   * @param options - `source` names the archive in the report, by its file name.
   * @returns the import report.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` when the service is disposed, and the refusal the archive earns.
   */
  import(bytes: Uint8Array, options: { readonly source?: string } = {}): Promise<ArchiveImportReport> {
    if (this.disposed) throw new ArchiveError('ARCHIVE_STAGING_FAILED', 'the archive service is disposed, so it stages nothing')
    return this.importer.import(bytes, options)
  }

  /**
   * Export one archive, or return the secrets that stop it.
   * @param input - the workspaces, the customisation, the origin and the person's confirmation.
   * @returns the archive bytes, or the findings that stopped the export.
   */
  export(input: ArchiveExportInput): ArchiveExportResult {
    return exportArchive(input)
  }

  /**
   * End the service: an import that has not published yet stages nothing.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new Error('the archive service is disposed'))
  }
}

/**
 * Register the archive service on a context.
 * @param ctx - the context the registration lives on.
 * @param config - the staging parent, the workspace store and the keys the home vouches for.
 * @returns the service and the disposer that ends the registration.
 */
export function registerArchive(ctx: ArchiveContext, config: ArchiveImporterConfig): ArchiveHandle {
  const service = new ArchiveService(config)
  const stopEffect = ctx.effect(() => () => { service.dispose() }, '@delo/archive: import and export')
  let disposed = false
  return {
    service,
    dispose: () => {
      if (disposed) return
      disposed = true
      stopEffect()
      service.dispose()
    },
  }
}
