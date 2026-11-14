/**
 * A TCP forwarder the journey runs inside its containers, with the container's own Node: it listens on each named port
 * of one address and pipes every connection to the same port of one target host. The gateway container runs it from
 * its external interface to the computer that runs the spec; the journey container runs it from its loopback address to
 * the gateway, so the launcher's loopback channel and log origins and the model's base URL reach the spec's servers and
 * nothing else.
 *
 * `node forward.mjs <listen address> <target host> <port>...`
 */
import { connect, createServer } from 'node:net'

const [listen, target, ...ports] = process.argv.slice(2)
if (listen === undefined || target === undefined || ports.length === 0) {
  process.stderr.write('usage: node forward.mjs <listen address> <target host> <port>...\n')
  process.exit(2)
}
for (const port of ports.map(Number)) {
  const server = createServer((inbound) => {
    const outbound = connect({ host: target, port })
    inbound.pipe(outbound)
    outbound.pipe(inbound)
    // Either side's failure closes both, so a refused target looks to the client like a closed connection.
    inbound.on('error', () => outbound.destroy())
    outbound.on('error', () => inbound.destroy())
  })
  server.listen(port, listen, () => process.stdout.write(`forwarding ${listen}:${String(port)} to ${target}:${String(port)}\n`))
}
