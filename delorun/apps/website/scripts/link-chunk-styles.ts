/**
 * Links the stylesheets of chunks a prerendered page renders but the browser loads later, as `RENDERED_CHUNK_STYLES` names
 * them. It runs after the build's prerender, before `check-styles.ts`.
 *
 * Usage: `node scripts/link-chunk-styles.ts [out-dir]`
 *
 * @module @delorun/website/scripts/link-chunk-styles
 */
import { RENDERED_CHUNK_STYLES } from '../src/site/config.ts'
import { linkChunkStyles } from './styles.ts'

linkChunkStyles(process.argv[2] ?? 'out', RENDERED_CHUNK_STYLES)
