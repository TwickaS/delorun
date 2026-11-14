/**
 * A fake `tailscale` for the CLI's reach specs that keeps a serve configuration as `tailscaled` would: `serve --bg --https=<port>
 * <target>` sets the port's HTTPS rule, `serve --https=|--http=|--tcp=<port> off` removes the port's background rule or
 * fails as Tailscale does when there is none, and `serve status --json` prints the configuration in the JSON of Go's
 * `ipn.ServeConfig`. A spec sets `config` to plant a rule, a Funnel or a foreground session, and `answers` to replace
 * one invocation's answer.
 */
import type { TailscaleResult, TailscaleRunner } from '@delorun/reach'

/** The fields of `ipn.ServeConfig` the provider reads. */
export interface ServeConfigJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string; Text?: string }> }>
  AllowFunnel?: Record<string, boolean>
  Foreground?: Record<string, ServeConfigJson>
}

/** Which invocation an answer replaces: `version`, `status`, `serve status`, `serve set` or `serve off`. */
export type FakeCall = 'version' | 'status' | 'serve status' | 'serve set' | 'serve off'

/** The fake and what it recorded. */
export interface FakeTailscale {
  readonly run: TailscaleRunner
  /** Every invocation's arguments, in order. */
  readonly calls: string[][]
  /** The background configuration, with any foreground sessions under `Foreground`. */
  config: ServeConfigJson
  /** Answers that replace an invocation's own, as a value or computed per call. */
  readonly answers: Partial<Record<FakeCall, TailscaleResult | (() => TailscaleResult)>>
}

const OK: TailscaleResult = { code: 0, stdout: '', stderr: '' }

/**
 * A fake `tailscale` signed in as `host` with HTTPS certificates on.
 * @param host - this machine's `ts.net` name.
 * @param answers - answers that replace an invocation's own.
 * @returns the fake.
 */
export function fakeTailscale(host: string, answers: FakeTailscale['answers'] = {}): FakeTailscale {
  const fake: FakeTailscale = {
    calls: [],
    config: {},
    answers,
    run: async (args) => {
      fake.calls.push([...args])
      const kind = callOf(args)
      const answer = fake.answers[kind]
      if (answer !== undefined) return Promise.resolve(typeof answer === 'function' ? answer() : answer)
      switch (kind) {
        case 'version': return OK
        case 'status': return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${host}.` }, CertDomains: [host] }), stderr: '' }
        case 'serve status': return { code: 0, stdout: `${JSON.stringify(fake.config, null, 2)}\n`, stderr: '' }
        case 'serve set': {
          const port = (args[2] ?? '').replace('--https=', '')
          fake.config = {
            ...fake.config,
            TCP: { ...fake.config.TCP, [port]: { HTTPS: true } },
            Web: { ...fake.config.Web, [`${host}:${port}`]: { Handlers: { '/': { Proxy: args[3] ?? '' } } } },
          }
          return OK
        }
        case 'serve off': {
          const port = (args[1] ?? '').replace(/^--[a-z]+=/, '')
          if (fake.config.TCP?.[port] === undefined) return { code: 1, stdout: '', stderr: 'error: handler does not exist\n' }
          const without = <T>(map: Record<string, T> | undefined, key: string): Record<string, T> => Object.fromEntries(Object.entries(map ?? {}).filter(([name]) => name !== key))
          fake.config = { ...fake.config, TCP: without(fake.config.TCP, port), Web: without(fake.config.Web, `${host}:${port}`) }
          return OK
        }
        default: {
          const unexpected: never = kind
          throw new Error(`fake tailscale: ${String(unexpected)}`)
        }
      }
    },
  }
  return fake
}

/**
 * The invocation an argument list is.
 * @param args - the arguments.
 * @returns its kind.
 */
function callOf(args: readonly string[]): FakeCall {
  if (args[0] === 'version' || args[0] === 'status') return args[0]
  if (args[0] === 'serve' && args[1] === 'status') return 'serve status'
  if (args[0] === 'serve' && args.at(-1) === 'off') return 'serve off'
  if (args[0] === 'serve' && args[1] === '--bg') return 'serve set'
  throw new Error(`fake tailscale: unexpected invocation ${args.join(' ')}`)
}

/**
 * This home's own rule on `<host>:<port>` to a listener port, as `serve set` leaves it.
 * @param host - the `ts.net` name.
 * @param port - the serve port.
 * @param listenerPort - the listener port.
 * @returns the configuration.
 */
export function ownRule(host: string, port: number, listenerPort: number): ServeConfigJson {
  return { TCP: { [String(port)]: { HTTPS: true } }, Web: { [`${host}:${String(port)}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${String(listenerPort)}` } } } } }
}
