/**
 * Spike test page for WP1.19: an HTTP server on 127.0.0.1 that answers `GET /` with one fixed HTML page and every
 * other request with 404. It serves no file from disk, so a `tailscale serve` or Funnel target pointing at it exposes
 * only this page.
 *
 * Usage: node test-page-server.ts
 * Prints one JSON line with the port the operating system assigned.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const page = '<!doctype html><meta charset="utf-8"><title>ts-net rp-id spike</title><p>WP1.19 relying-party ID test page.</p>\n';

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: `127.0.0.1:${(server.address() as AddressInfo).port}` }));
});
