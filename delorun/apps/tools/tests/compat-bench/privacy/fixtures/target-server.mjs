// A stand-in for the outside world in the helper spec: plain HTTP on 8080 and HTTPS on 8443 with a self-signed
// certificate (the helper spec starts its proxy with upstream checking off for it).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'target-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=target.test'], { stdio: 'ignore' })
const answer = (_request, response) => { response.end('ok') }
http.createServer(answer).listen(8080, '0.0.0.0')
https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, answer).listen(8443, '0.0.0.0', () => { console.log('ready') })
