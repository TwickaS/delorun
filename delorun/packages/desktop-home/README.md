---
description: "How the studio's client gates learn that the page is at the person's computer inside the Delorun desktop app, for maintainers who add a gate or change what the desktop reports."
kind: "package-library"
---

# @delorun/desktop-home

## Summary

On the web, the studio tells "at your computer" from "on a device" by the page's host name: a loopback host is the computer. The Delorun desktop app serves its own bundled studio under `dsh-app://app`, so the host name is `app` and says nothing about where the person is. The desktop's preload therefore exposes `globalThis.delorunDesktop`, a frozen object with one key, `homeKind`, and this package turns it into the answer the client gates need. The package is a studio library, exported from source: it runs in the browser, has no dependencies and imports no Cordis.

## Contents

- [The answer](#the-answer)
- [What it decides and what it does not](#what-it-decides-and-what-it-does-not)
- [Call sites](#call-sites)
- [Tests](#tests)

## The answer

`atComputer(fallback)` returns:

| `delorunDesktop.homeKind` | Answer | Meaning |
| --- | --- | --- |
| `bundled` | `true` | The home the app runs on this computer |
| `wsl` | `true` | A home in the person's own WSL distribution; the app is "this computer" (A579) |
| `remote` | `false` | A home on another machine; the app is a device |
| absent, `null`, not an object, any other value, a read that throws, or any page but the application document | `fallback` | Outside the desktop app: the caller's own test, unchanged |

The object is read only on the desktop's application document: `location.protocol` is `dsh-app:` and `location.hostname` is `app`, the condition under which the preload exposes it. On any other page, a web page included, `delorunDesktop` is ignored, so a script that defines it there, or markup whose `id` or `name` makes an element the global (DOM clobbering), changes nothing: the value must be exactly one of the three strings.

Every caller passes the test it used before: the page's host name, or the connection's `isLoopback`. An absent, unknown or hostile value, or any value on a web page, therefore never changes what the web does. `desktopHomeKind()` returns the kind itself, or `undefined`, under the same rules.

## What it decides and what it does not

Only what a page shows or hides. A client gate shows a computer-only control or points to the computer; it grants nothing. The home's server-side checks stay the authority: a request that did not arrive on the computer's own listener is refused (`403 LOOPBACK_REQUIRED`) whatever the page showed or claimed, and the preload's value is a label the page reads, never a credential. A page that lies about its home kind sees controls the home then refuses.

## Call sites

Every place that reads the desktop's home kind, and why each reads it:

| Call site | What it shows or hides |
| --- | --- |
| [`plugin-onboarding/src/client/host-api.ts`](../plugin-onboarding/src/client/host-api.ts) `pageAtComputer`, used by `readReach` | Whether the guide's Reach step applies: a remote page skips it |
| [`plugin-onboarding/src/client/index.ts`](../plugin-onboarding/src/client/index.ts) `deferredEntry.atComputer` | The sidebar's "finish setup" entry, which shows only at the computer |
| [`plugin-onboarding/src/client/index.ts`](../plugin-onboarding/src/client/index.ts) `browserPage.services.remote` | On the Browser settings page, the download and test buttons, which a remote page hides |
| [`bundle-local/src/client/at-computer.ts`](../bundle-local/src/client/at-computer.ts) `pageAtComputer`, used at ten places in [`bundle-local/src/client/index.ts`](../bundle-local/src/client/index.ts) | The page's Face ID grant and pass (`applyFaceGrant`), PIN (`applyPin`) and unlock (`applyUnlock`) sources; the agent seats' reach (`provideAgentSeatReach`); the pairing notice, which only the computer's page registers, and the session-rotation reload, which only a page on a device arms; and the PIN mode, Face ID, setup commands and setup versions sections. Each shows its computer-only control at the computer and points to the computer on a device |

A new gate that asks "at the computer?" uses this package and is added to the table; none reads `location.hostname` itself.

Upstream's `ConnectionHandle.isLoopback` is not changed: it also drives the connection's offline handling and the settings page's host facts, and it stays the web answer that every caller passes as `fallback`.

## Tests

`pnpm exec vitest run --config delorun/vitest.config.ts delorun/packages/desktop-home` covers each kind, the absent case, values that are not the preload's own shape (strings, `null`, numbers, a wrong spelling, a throwing getter, extra keys), a frozen object, a value planted on an `http:` or `https:` page, and DOM clobbering by an element or a form input. Source guards in `bundle-local/tests/client-gates-source.spec.ts` and `plugin-onboarding/tests/client-gates-source.spec.ts` fail when a client source reads `isLoopback` or the host name for a loopback name itself again. The call sites' own specs cover the wiring: [`bundle-local/tests/at-computer.spec.ts`](../bundle-local/tests/at-computer.spec.ts) and the host-api cases of [`plugin-onboarding/tests/guide.client.spec.tsx`](../plugin-onboarding/tests/guide.client.spec.tsx).
