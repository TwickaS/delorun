/**
 * Spike helper for WP1.18 and WP1.19: an HTTP CONNECT proxy on 127.0.0.1 that carries each tunnel through
 * `tailscale nc`, so curl and Chromium on a userspace-networking node can open this node's own `ts.net` address
 * over the tailnet. It tunnels only to the node's own MagicDNS name, as `tailscale status --json` reports it, and
 * refuses every other CONNECT target.
 *
 * Usage: node tailnet-connect-proxy.ts <tailscaled socket path>
 * Prints one JSON line with the proxy's port; the node's name is never printed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const tailscaledSocket = process.argv[2];
if (tailscaledSocket === undefined) throw new Error('usage: node tailnet-connect-proxy.ts <tailscaled socket path>');

const status = JSON.parse(execFileSync('tailscale', [`--socket=${tailscaledSocket}`, 'status', '--json'], { encoding: 'utf8' })) as {
  Self: { DNSName: string };
};
const selfName = status.Self.DNSName.replace(/\.$/, '');

const server = createServer((_request, response) => {
  response.writeHead(405).end();
});

server.on('connect', (request, client: Socket, head: Buffer) => {
  const [host, port] = (request.url ?? '').split(':');
  if (host !== selfName || port === undefined || !/^\d+$/.test(port)) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const nc = spawn('tailscale', [`--socket=${tailscaledSocket}`, 'nc', host, port], { stdio: ['pipe', 'pipe', 'inherit'] });
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length > 0) nc.stdin.write(head);
  client.pipe(nc.stdin);
  nc.stdout.pipe(client);
  nc.on('exit', () => client.destroy());
  client.on('error', () => nc.kill());
  client.on('close', () => nc.kill());
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ proxy: `127.0.0.1:${(server.address() as AddressInfo).port}` }));
});
