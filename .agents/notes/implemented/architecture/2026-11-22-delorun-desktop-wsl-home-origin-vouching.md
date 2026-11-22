# Agent Note: The desktop app vouches for its own page on a home in WSL2

Status: implemented

English | [中文](2026-11-22-delorun-desktop-wsl-home-origin-vouching.zh.md)

## Problem

A Delorun home refuses a state-changing computer-only action, such as approving a device or changing the PIN, unless the request arrived on the loopback listener, carries the studio's credential, and names the home's own loopback origin in `Origin`. A browser on the computer sends that `Origin` itself. The desktop app serves its studio page from `dsh-app://app`, and upstream's forwarder deletes `Origin` before it forwards a request, so the home refused every such action from the app, even on the person's own WSL2 home, where the app is the person at the computer.

## Decision

For a home in WSL2 only, the app's forwarder sets `Origin` to that home's exact loopback origin and `Sec-Fetch-Site` to `same-origin` on a request that carried `Origin: dsh-app://app`. A request with no `Origin` gets none, and a request with any other `Origin`, or a `cross-site` or `same-site` fetch site, is refused with 403 before anything is forwarded. The main window navigates only to the studio's entry document and the shell's own documents. A bundled home keeps upstream's behaviour, and a remote home never receives the rewrite, because there the app is a device. Only the default session's handler for the `dsh-app` scheme reaches the forwarder, so a guest webview and another session partition never do. The cookie and the one-time sign-in link stay in the main process. [The threat model](../../../delorun/docs/security/threat-model.md#the-desktop-app-and-a-home-in-wsl2) states the boundary and its limits, and [the fundamentals page](../../../delorun/docs/security/fundamentals.md) holds each rule as F18 to F24 with the code that enforces it and the specs that prove it. The owner accepted the vouching on 2026-11-22.

## Verification

Each rule has a spec that feeds the refused case: another origin, a bundled or remote kind, no `Origin`, a guest partition, a cookie in a log or a cookie store, and a link on a command line. `gates:fundamentals` checks that every named file and spec title exists. Two things have no spec: whether a Windows connection through WSL's localhost forwarding arrives at the home as loopback, which a probe measures and has not run, and the independent review of the change, which is not yet recorded.

## Alternatives considered

**No vouching, and a browser for those actions.** Nothing in the app could then approve a device or change the PIN, so the app would never be the person's own computer.

**Vouching and Windows Hello.** A second factor on the person's own computer adds a prompt without a defence against the threats that remain, which are script in the page and another process of the same user.

**Vouching for a remote home too.** A remote home must keep treating the app as a device; the rewrite would remove the difference between the computer and a device.

## Consequences

The app has the computer's powers on a WSL2 home, as a browser on the PC has. Script that runs in the app's page, such as a cross-site scripting flaw in the studio client, acts as the person at the computer, and the app confines no other process of the same Windows user. A change to the forwarder, to what reaches it or to what the app holds as a credential is a change to F18 to F24, needs this note updated, and goes through the review rules for a trust boundary.
