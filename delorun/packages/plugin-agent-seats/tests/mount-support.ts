/**
 * Stand-ins for the services a profile supplies around the seats plugin: the preview flags, the Connection, the preset
 * registry and the profile folder.
 */
import type { Context} from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { PreviewFlagDeclaration, PreviewFlagId, PreviewFlags } from '@delorun/preview-flags'
import { LIVE_AGENTS } from '../src/index.ts'

/** The stand-in for the preview-flags row: it records declarations and reports one flag as on or off. */
export class FakeFlags extends Service implements PreviewFlags {
  static on = false
  readonly declared: PreviewFlagDeclaration[] = []

  constructor(ctx: Context) {
    super(ctx, 'previewFlags')
  }

  declare(flag: PreviewFlagDeclaration): () => void {
    this.declared.push(flag)
    return () => { this.declared.splice(this.declared.indexOf(flag), 1) }
  }

  isOn(id: PreviewFlagId): boolean {
    return id === LIVE_AGENTS.id && FakeFlags.on
  }

  list(): never[] {
    return []
  }
}

/** The stand-in for the Connection: it records the Fetch routes and the request listeners. */
export class FakeConnection extends Service {
  readonly routes: ConnectionFetchRoute[] = []
  readonly fetch = {
    register: (route: ConnectionFetchRoute): (() => Promise<void>) => {
      this.routes.push(route)
      return () => { this.routes.splice(this.routes.indexOf(route), 1); return Promise.resolve() }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }
}

/** The stand-in for the preset registry: it records the definitions. */
export class FakePresets extends Service {
  readonly definitions: PresetDefinition[] = []

  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
  }

  register(definition: PresetDefinition): Promise<() => Promise<void>> {
    this.definitions.push(definition)
    return Promise.resolve(() => { this.definitions.splice(this.definitions.indexOf(definition), 1); return Promise.resolve() })
  }
}

/** The stand-in for the profile's folder. */
export class FakeProfile extends Service {
  readonly dir: string

  constructor(ctx: Context, dir: string) {
    super(ctx, 'profileContext')
    this.dir = dir
  }
}

/**
 * Collect what the plugin's loggers say at warning level or above.
 * @param ctx - the context the plugin is mounted on.
 * @returns the message texts, appended as they are logged.
 */
export function captureWarnings(ctx: Context): string[] {
  const texts: string[] = []
  ctx.logger.exporter({
    colors: false,
    levels: { default: 2 },
    export: (message) => { texts.push(message.args.map(String).join(' ')) },
  })
  return texts
}

/**
 * Read a partial fake as the interface a plugin under test expects.
 * @param value - the fake; it implements the members the spec reaches.
 * @returns the same value, typed as `T`.
 */
export function fake<T>(value: object): T {
  return value as T
}
