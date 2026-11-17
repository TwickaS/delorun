/**
 * The fields the installed-release smoke reads from an installed studio's answers, validated where they arrive: the packs
 * routes' snapshot (`@delorun/plugin-packs/wire`, whose queue items are `@delorun/install-queue`'s `InstallItem`) and
 * the plugin manager's `listBundles` and `listPlugins` answers. Fields the smoke does not read pass through unchecked,
 * so a field a release adds does not fail the smoke, and a field it renames fails it by name.
 *
 * @module @delorun/release/installed-smoke/wire
 */
import { z } from 'zod'

/** One install list item. */
export const QueueItem = z.looseObject({
  key: z.string(),
  state: z.string(),
  failure: z.looseObject({ code: z.string(), message: z.string() }).optional(),
})

/** One install list item. */
export type QueueItem = z.infer<typeof QueueItem>

/** The packs routes' snapshot. */
export const PacksSnapshot = z.looseObject({
  supported: z.boolean(),
  reason: z.string().optional(),
  release: z.string().optional(),
  packs: z.array(z.looseObject({ name: z.string() })),
  queue: z.array(QueueItem),
})

/** The packs routes' snapshot. */
export type PacksSnapshot = z.infer<typeof PacksSnapshot>

/** A packs route's result: the snapshot, or why nothing happened. */
export const PacksResult = z.union([
  z.looseObject({ ok: z.literal(true), value: PacksSnapshot }),
  z.looseObject({ ok: z.literal(false), error: z.looseObject({ code: z.string(), message: z.string() }) }),
])

/** One bundle of `pluginManager/listBundles`. */
export const BundleView = z.looseObject({
  name: z.string(),
  installed: z.boolean(),
  enabled: z.boolean(),
  error: z.unknown().optional(),
  rows: z.array(z.looseObject({ rowId: z.string(), moduleName: z.string(), entryId: z.string().optional() })),
})

/** One bundle of `pluginManager/listBundles`. */
export type BundleView = z.infer<typeof BundleView>

/** One loader entry of `pluginManager/listPlugins`. */
export const PluginView = z.looseObject({
  entryId: z.string(),
  moduleName: z.string(),
  enabled: z.boolean(),
  fiberPhase: z.string().nullable(),
  diagnostic: z.string().optional(),
})

/** One loader entry of `pluginManager/listPlugins`. */
export type PluginView = z.infer<typeof PluginView>

/**
 * Read an answer against a schema.
 * @param schema - the schema.
 * @param value - the parsed JSON.
 * @param what - the answer's name, for the message.
 * @returns the value.
 * @throws Error naming the answer and the first field that does not match.
 */
export function readAnswer<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new Error(`${what} answered fields this smoke does not read: ${issue.path.join('.') || '(top)'}: ${issue.message}`)
  }
  return parsed.data
}
