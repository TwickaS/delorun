/**
 * The bench's privacy hooks: a Node preload that records, for the process and every child (which inherit
 * `NODE_OPTIONS`), the TCP and UDP connects (host, port, and the address the name resolved to), the listens, the child
 * processes started, the environment names read, and the opens of watched files, one JSON line each, appended to the
 * file named by `DELORUN_PRIVACY_LOG`. `DELORUN_PRIVACY_WATCH` holds a JSON list of `{ label, path }`; a path ending in
 * `/` matches everything below it. Load it with `NODE_OPTIONS="--import <absolute path>"`; without the log variable it
 * changes nothing. It extends the idea of `src/network-log.mjs` (a connect log) with the other four kinds of event, and
 * does not import it, so the two preloads can run side by side. A hook never throws into the code it observes.
 *
 * Events are only a plain-English summary's raw material: a hook can miss what runs through a native addon or a raw
 * file descriptor, which is why the helper container logs connects and listens again from outside the process.
 *
 * @module @delorun/tools/compat-bench/privacy/preload
 */
import childProcess from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const logPath = process.env.DELORUN_PRIVACY_LOG
if (logPath !== undefined && logPath !== '') install(logPath)

/**
 * Install every hook.
 * @param {string} path - the log file.
 */
function install(path) {
  const append = fs.appendFileSync
  const pid = process.pid
  /** @param {Record<string, unknown>} event */
  const log = (event) => {
    try { append(path, `${JSON.stringify({ ts: Date.now(), pid, ...event })}\n`) } catch { /* the log is best effort */ }
  }
  /** @type {Array<{ label: string, path: string }>} */
  let watch = []
  try { watch = JSON.parse(process.env.DELORUN_PRIVACY_WATCH ?? '[]') } catch { watch = [] }
  log({ t: 'start', cmd: process.argv.slice(1).join(' ').slice(0, 200) })

  // Connects. Fetch, `http`, `https`, `tls` and `net.connect` all reach `net.Socket#connect`.
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connectAndLog(...args) {
    try {
      // Node's own callers pass the arguments already normalised as `[options, callback]`.
      const options = Array.isArray(args[0]) ? args[0][0] : args[0]
      const target = typeof options === 'object' && options !== null ? options : { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: options }
      const host = String(target.host ?? target.hostname ?? target.path ?? 'localhost')
      const port = String(target.port ?? '')
      log({ t: 'connect', host, port, proto: 'tcp' })
      this.once('connect', () => { try { log({ t: 'connected', host, port, address: String(this.remoteAddress ?? '') }) } catch { /* ignore */ } })
    } catch { /* ignore */ }
    return connect.apply(this, args)
  }

  // UDP: a send names its destination; a bind is a listen.
  const send = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function sendAndLog(...args) {
    try {
      const strings = args.filter(arg => typeof arg === 'string')
      const numbers = args.filter(arg => typeof arg === 'number')
      const port = numbers.length > 0 ? numbers[numbers.length - 1] : ''
      if (strings.length > 0 && typeof port === 'number' && port > 0) log({ t: 'connect', host: strings[strings.length - 1], port: String(port), proto: 'udp' })
    } catch { /* ignore */ }
    return send.apply(this, args)
  }

  // Listens: the address is known once the server is listening (port 0 is given a real one then).
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function listenAndLog(...args) {
    try {
      this.once('listening', () => {
        try {
          const address = this.address()
          if (typeof address === 'string') log({ t: 'listen', host: address, port: '' })
          else if (address !== null) log({ t: 'listen', host: address.address, port: String(address.port) })
        } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
    return listen.apply(this, args)
  }

  // Child processes. Every asynchronous way in goes through ChildProcess#spawn; the synchronous ones are patched by name.
  const spawn = childProcess.ChildProcess.prototype.spawn
  childProcess.ChildProcess.prototype.spawn = function spawnAndLog(options) {
    try { log({ t: 'exec', file: String(options?.file ?? ''), args: (options?.args ?? []).slice(1).join(' ').slice(0, 200) }) } catch { /* ignore */ }
    return spawn.call(this, options)
  }
  // Starting a child without an `env` makes Node list the whole environment; that is not the code reading names, so
  // the environment hooks stay quiet while a child_process function prepares its arguments.
  let quiet = 0
  for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
    const original = childProcess[name]
    const sync = name.endsWith('Sync')
    childProcess[name] = function childAndLog(...args) {
      if (sync) {
        try { log({ t: 'exec', file: String(args[0]), args: (Array.isArray(args[1]) ? args[1].join(' ') : '').slice(0, 200) }) } catch { /* ignore */ }
      }
      quiet++
      try { return original.apply(this, args) } finally { quiet-- }
    }
  }

  // Environment names: every read of a name, and a note that the whole environment was listed.
  const seen = new Set()
  let enumerated = false
  const env = process.env
  process.env = new Proxy(env, {
    get(target, name, receiver) {
      if (quiet === 0 && typeof name === 'string' && !seen.has(name)) { seen.add(name); log({ t: 'env', name }) }
      return Reflect.get(target, name, receiver)
    },
    has(target, name) {
      if (quiet === 0 && typeof name === 'string' && !seen.has(name)) { seen.add(name); log({ t: 'env', name }) }
      return Reflect.has(target, name)
    },
    ownKeys(target) {
      if (quiet === 0 && !enumerated) { enumerated = true; log({ t: 'env', name: '*' }) }
      return Reflect.ownKeys(target)
    },
  })

  // Opens of watched files. A path is resolved, so `../` and relative names match.
  const reported = new Set()
  /** @param {unknown} file */
  const watched = (file) => {
    try {
      let name
      if (typeof file === 'string') name = file
      else if (file instanceof URL) name = fileURLToPath(file)
      else if (Buffer.isBuffer(file)) name = file.toString()
      else return
      const absolute = resolve(name)
      for (const entry of watch) {
        const hit = entry.path.endsWith('/') ? absolute.startsWith(entry.path) || `${absolute}/` === entry.path : absolute === entry.path
        if (hit && !reported.has(absolute)) { reported.add(absolute); log({ t: 'open', label: entry.label, path: absolute }) }
      }
    } catch { /* ignore */ }
  }
  for (const name of ['openSync', 'open', 'readFileSync', 'readFile', 'createReadStream', 'copyFileSync', 'copyFile', 'readdirSync', 'readdir', 'opendirSync', 'opendir']) {
    const original = fs[name]
    if (typeof original !== 'function') continue
    fs[name] = function openAndLog(...args) { watched(args[0]); return original.apply(this, args) }
  }
  for (const name of ['open', 'readFile', 'copyFile', 'readdir', 'opendir']) {
    const original = fs.promises[name]
    if (typeof original !== 'function') continue
    fs.promises[name] = function openAndLog(...args) { watched(args[0]); return original.apply(this, args) }
  }
  syncBuiltinESMExports()
}
