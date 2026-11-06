/**
 * Spike probe for WP1.19: opens this node's `ts.net` test page in Playwright's browsers and records which WebAuthn
 * relying-party IDs a page there may use, and whether a passkey registers and asserts.
 *
 * Usage: node rp-id-probe.ts <tailscaled socket> <scenario> [proxy host:port]
 *   serve      Chromium through the tailnet CONNECT proxy at https://<host>/, with a CTAP2 virtual authenticator
 *              (platform `internal`, then security key `usb`); Firefox and WebKit without an authenticator.
 *   funnel     The same at https://<host>:8443/ over the public internet, with no proxy.
 *   cross      Chromium through the proxy: register at https://<host>/, then assert at https://<host>:8443/ in the
 *              same page and authenticator.
 *
 * Without an authenticator, a candidate is "rejected" when the browser throws SecurityError before looking for an
 * authenticator, and "accepted, no authenticator" when it waits and ends with NotAllowedError or a timeout.
 * Output is one JSON document with the node's name replaced by `<node>.<tailnet>.ts.net`.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

type Playwright = typeof import('playwright');
const playwright = createRequire(new URL('../../../../../apps/web/package.json', import.meta.url))('playwright') as Playwright;

const [tailscaledSocket, scenario, proxy] = process.argv.slice(2);
if (tailscaledSocket === undefined || scenario === undefined) throw new Error('usage: node rp-id-probe.ts <tailscaled socket> <serve|funnel|cross> [proxy]');

const status = JSON.parse(execFileSync('tailscale', [`--socket=${tailscaledSocket}`, 'status', '--json'], { encoding: 'utf8' })) as {
  Self: { DNSName: string };
};
const host = status.Self.DNSName.replace(/\.$/, '');
const tailnetDomain = host.slice(host.indexOf('.') + 1);
const candidates = [host, tailnetDomain, 'ts.net', 'net'];
const redact = (text: string): string => text.split(host).join('<node>.<tailnet>.ts.net').split(tailnetDomain).join('<tailnet>.ts.net');

type CeremonyResult = Record<string, string | boolean | number>;

/** Runs `navigator.credentials.create` in the page for one relying-party ID. */
const createIn = async ({ rpId, timeout }: { rpId: string; timeout: number }): Promise<CeremonyResult> => {
  const started = performance.now();
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'Delo spike' },
        user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'owner', displayName: 'spike' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout,
      },
    })) as PublicKeyCredential;
    const clientData = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON)) as { type: string; origin: string };
    return { ok: true, type: clientData.type, origin: clientData.origin };
  } catch (error) {
    const failure = error as DOMException;
    return { ok: false, name: failure.name, message: failure.message, ms: Math.round(performance.now() - started) };
  }
};

/** Runs `navigator.credentials.get` in the page and checks the assertion's rpIdHash and flags. */
const getIn = async ({ rpId, timeout }: { rpId: string; timeout: number }): Promise<CeremonyResult> => {
  try {
    const credential = (await navigator.credentials.get({
      publicKey: { rpId, challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', timeout },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAssertionResponse;
    const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON)) as { type: string; origin: string };
    const authData = new Uint8Array(response.authenticatorData);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
    const flags = authData[32] ?? 0;
    return {
      ok: true,
      type: clientData.type,
      origin: clientData.origin,
      rpIdHashMatches: expected.every((byte, index) => authData[index] === byte),
      userPresent: (flags & 0x01) !== 0,
      userVerified: (flags & 0x04) !== 0,
    };
  } catch (error) {
    const failure = error as DOMException;
    return { ok: false, name: failure.name, message: failure.message };
  }
};

type BrowserName = 'chromium' | 'firefox' | 'webkit';
type Page = Awaited<ReturnType<Awaited<ReturnType<Playwright['chromium']['launch']>>['newPage']>>;

async function launchAndLoad(browserName: BrowserName, url: string, viaProxy: boolean) {
  const browser = await playwright[browserName].launch({
    headless: true,
    ...(viaProxy && proxy !== undefined ? { proxy: { server: `http://${proxy}` } } : {}),
  });
  const page = await browser.newPage();
  try {
    const response = await page.goto(url, { timeout: 90_000 });
    const context = await page.evaluate(() => ({ origin: location.origin, isSecureContext, webauthn: typeof PublicKeyCredential === 'function' }));
    return { browser, page, loaded: { status: response?.status() ?? 0, ...context } };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * Loads the page, retrying up to twice after a failed navigation and recording each failure: Funnel's ingress
 * closed some connections during TLS setup, with HTTP/1.1 and HTTP/2 alike, and the WebAuthn results do not depend
 * on which attempt loaded the page.
 */
async function open(browserName: BrowserName, url: string, viaProxy: boolean) {
  const failedAttempts: string[] = [];
  for (;;) {
    try {
      const opened = await launchAndLoad(browserName, url, viaProxy);
      return { ...opened, loaded: { ...opened.loaded, failedAttempts } };
    } catch (error) {
      failedAttempts.push((error as Error).message.split('\n')[0] ?? '');
      if (failedAttempts.length > 2) throw error;
    }
  }
}

async function addAuthenticator(page: Page, transport: 'internal' | 'usb') {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function probeOrigin(url: string, viaProxy: boolean) {
  const results: Record<string, unknown> = {};
  for (const transport of ['internal', 'usb'] as const) {
    const { browser, page, loaded } = await open('chromium', url, viaProxy);
    await addAuthenticator(page, transport);
    const create: Record<string, CeremonyResult> = {};
    for (const rpId of candidates) create[rpId] = await page.evaluate(createIn, { rpId, timeout: 10_000 });
    const get = await page.evaluate(getIn, { rpId: host, timeout: 10_000 });
    results[`chromium ${browser.version()} (${transport} virtual authenticator)`] = { loaded, create, get };
    await browser.close();
  }
  for (const browserName of ['firefox', 'webkit'] as const) {
    let opened: Awaited<ReturnType<typeof open>>;
    try {
      opened = await open(browserName, url, viaProxy);
    } catch (error) {
      // A browser whose system libraries are missing is recorded as not run, not as a WebAuthn result.
      results[browserName] = { launchFailed: (error as Error).message.split('\n').map((line) => line.replace(/[║╔╗╚╝═]/g, '').trim()).filter(Boolean).slice(0, 3).join(' ') };
      continue;
    }
    const { browser, page, loaded } = opened;
    const create: Record<string, CeremonyResult> = {};
    if (loaded.webauthn) {
      for (const rpId of candidates) create[rpId] = await page.evaluate(createIn, { rpId, timeout: 3_000 });
    }
    results[`${browserName} ${browser.version()} (no authenticator)`] = { loaded, create };
    await browser.close();
  }
  return results;
}

async function cross() {
  const { browser, page, loaded } = await open('chromium', `https://${host}/`, true);
  await addAuthenticator(page, 'internal');
  const register = await page.evaluate(createIn, { rpId: host, timeout: 10_000 });
  await page.goto(`https://${host}:8443/`, { timeout: 90_000 });
  const assertOnOtherPort = await page.evaluate(getIn, { rpId: host, timeout: 10_000 });
  await browser.close();
  return { [`chromium ${browser.version()}`]: { loaded, registerOnServeOrigin: register, assertOnFunnelOrigin: assertOnOtherPort } };
}

const output =
  scenario === 'serve'
    ? await probeOrigin(`https://${host}/`, true)
    : scenario === 'funnel'
      ? await probeOrigin(`https://${host}:8443/`, false)
      : await cross();
console.log(redact(JSON.stringify({ scenario, host, candidates, results: output }, null, 2)));
