/**
 * A Node preload for a network fixture: records the host and port of every TCP connection a process opens, to the
 * file named by `DELO_NETWORK_LOG`, one `host:port` line each. Fetch, `http`, `https` and `tls` all connect through
 * `net.Socket#connect`, so the log holds every outbound connection of the process and its children, which inherit
 * `NODE_OPTIONS`. Load it with `NODE_OPTIONS="--import <absolute path>"`; without the variable it changes nothing.
 *
 * @module @delo/tools/network-log
 */
import { appendFileSync } from 'node:fs'
import net from 'node:net'

const logPath = process.env.DELO_NETWORK_LOG
if (logPath !== undefined && logPath !== '') {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connectAndLog(...args) {
    const options = args[0]
    const target = typeof options === 'object' && options !== null
      ? options
      : { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: options }
    const host = target.host ?? target.path ?? 'localhost'
    appendFileSync(logPath, `${String(host)}:${String(target.port ?? '')}\n`)
    return connect.apply(this, args)
  }
}
