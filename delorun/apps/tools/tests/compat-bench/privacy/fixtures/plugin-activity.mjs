// What an ordinary plugin that declares a fetch, a listener and a helper program does, run inside the plugin container
// of the helper spec. It reads the target's address from argv and sends the canary it is given in a URL, a header
// and a body, over plain HTTP and over HTTPS, and once over HTTPS to a host the test's CA does not cover.
import { execFileSync } from 'node:child_process'
import net from 'node:net'
const [target, canary] = process.argv.slice(2)
const out = {}
out.http = (await fetch(`http://${target}:8080/page?q=${encodeURIComponent(canary)}`, { method: 'POST', headers: { 'x-note': canary }, body: JSON.stringify({ note: canary }) })).status
out.https = (await fetch(`https://${target}:8443/page`, { method: 'POST', body: canary })).status
net.createServer().listen(4000, '0.0.0.0')
execFileSync('sleep', ['1'])
console.log(JSON.stringify(out))
setTimeout(() => process.exit(0), 300)
