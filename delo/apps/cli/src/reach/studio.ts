/**
 * The CLI's requests to its own studio on the loopback listener: the device routes of `@delo/home-auth` and the reach
 * status of `@delo/reach`. A program sends no `Origin`, and the loopback listener's `Host` is the studio's own, so the
 * routes treat the request as the person's at this computer.
 *
 * @module @delo/cli/reach/studio
 */
import { request as httpRequest } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { SETUP_DEFAULT_PORT } from '@delo/contract-setup-answers'
import { profileDirectory } from '../profile.ts'

/** One answer of the studio. */
export interface StudioReply {
  readonly status: number
  /** The parsed JSON body, or undefined for a body that is not JSON. */
  readonly body: unknown
}

/** Sends one request to the studio on a loopback port. */
export type StudioClient = (port: number, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<StudioReply>

/**
 * The port the profile's studio listens on: the `webserver` row's `port` in the profile's own patch, or setup's
 * default.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the port.
 */
export function studioPort(home: string, profile: string): number {
  const path = join(profileDirectory(home, profile), 'cordis.patch.yml')
  if (!existsSync(path)) return SETUP_DEFAULT_PORT
  let rows: unknown
  try {
    rows = parse(readFileSync(path, 'utf8'))
  } catch {
    // A patch the CLI cannot read leaves the studio on setup's default port, which the request then reaches or not.
    return SETUP_DEFAULT_PORT
  }
  if (!Array.isArray(rows)) return SETUP_DEFAULT_PORT
  const list: readonly unknown[] = rows
  for (const row of list) {
    if (typeof row !== 'object' || row === null || Reflect.get(row, 'id') !== 'webserver') continue
    const config: unknown = Reflect.get(row, 'config')
    const port: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'port') : undefined
    if (typeof port === 'number') return port
  }
  return SETUP_DEFAULT_PORT
}

/**
 * The client that sends a request to `127.0.0.1` with the studio's own `Host`.
 * @param port - the studio's port.
 * @param method - the method.
 * @param path - the path.
 * @param body - a JSON body.
 * @returns the reply.
 */
export const loopbackStudio: StudioClient = (port, method, path, body) => new Promise((resolve, reject) => {
  const text = body === undefined ? undefined : JSON.stringify(body)
  const request = httpRequest({
    host: '127.0.0.1', port, method, path, agent: false,
    headers: { host: `127.0.0.1:${String(port)}`, ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) },
  }, (response) => {
    let received = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { received += chunk })
    response.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(received)
      } catch {
        // A body that is not JSON, such as an upstream page, is answered as no body.
        parsed = undefined
      }
      resolve({ status: Number(response.statusCode), body: parsed })
    })
  })
  request.on('error', reject)
  request.end(text)
})

/**
 * A refusal's code and sentence from a studio reply.
 * @param reply - the reply.
 * @returns the `error` code and `message`, empty when absent.
 */
export function refusalOf(reply: StudioReply): { readonly error: string; readonly message: string } {
  const body = reply.body
  const error: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined
  const message: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'message') : undefined
  return { error: typeof error === 'string' ? error : `HTTP_${String(reply.status)}`, message: typeof message === 'string' ? message : '' }
}
