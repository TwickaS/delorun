---
description: "Design of reach on the person's own tailnet: device approval only at the home's computer through a short approval window, sign-in with the approved device key, what a remote session may and may not do, and the limit that stays."
---

# Reach on your own tailnet

English | [中文](reach.zh.md)

## Summary

Reach lets a person open their studio from their own phone or laptop over their own Tailscale tailnet, with no Delorun service in the path. A new device is approved only at the home's computer, during a short approval window the person opens there. An approved device signs in with its device key. A remote session can watch, reply, start chats, approve ordinary prompts and stop a run. Each sensitive action, granting full access among them, takes Face ID or that device's PIN, once per action; removing another device takes Face ID from a device that holds a passkey, never the PIN. Approving a device and changing reach wait until the person is at the computer. The home enforces both, not the remote page. The admission rules are [contract C4](../contracts/c04-admission.md), device approval [contract C5](../contracts/c05-device-approval.md), the reach providers [contract C7](../contracts/c07-reach-providers.md) and the identity factors [contract C14](../contracts/c14-oidc-passkeys.md).

## Contents

- [What exists today](#what-exists-today)
- [Exact Fetch routes a device meets](#exact-fetch-routes-a-device-meets)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Never run on a real tailnet or phone](#never-run-on-a-real-tailnet-or-phone)
- [Implementation status](#implementation-status)

## What exists today

- **Tailnet-private reach is built and off until the person turns it on** with `delorun reach on tailscale` or the yes answer to setup's phone question. `@delorun/reach` binds a fixed port on `127.0.0.1`, chosen once from 20000 to 32767, relays it to a reach listener and configures `tailscale serve` to that port, never through `sudo`. It refuses Funnel for the address and rechecks Tailscale every minute by default. Before it writes its own serve rule it removes any other rule on the serve port, and `delorun reach on` and `off` do the same, so a rule that an earlier run left in `tailscaled` is swept at the next start. Setup's `--yes` leaves reach off, and a `--config` document that names any reach option other than `none` is refused.
- **A device is approved at the computer, with a match code.** The person opens a 5-minute approval window in the loopback studio or with `delorun devices approve`; the phone's sign-in page asks for approval and shows an 8-digit code; the person picks the waiting request and types the code. The loopback form needs the studio's own credential and origin. `delorun devices approve` reaches the home process through the update channel with the start token, which the Host's own channel token cannot replace. A window refuses requests outside it before reading the body, at most 5 requests wait, and three wrong codes cancel that request.
- **A device signs in with its key.** An approved phone signs a fresh challenge with a key that never leaves it, and the home creates a session with the identity factor `tailnet-membership`: 12 hours idle, 14 days absolute, rolled after 24 hours of use and rotated by any approval or removal. Removing a device ends its sessions and closes its connections before the removal returns.
- **A device session is allowed a fixed list.** The session speaks for a `reach-device` principal, and Gateway calls and events pass a policy that refuses by default. It may do what the person does at the computer — read and drive chats, choose the preset a chat that has not started runs with, and read the plugins and the files of a chat's own workspace — and it may not change settings, plugins, workspaces, terminals, credentials or the account. [C14](../contracts/c14-oidc-passkeys.md#what-a-device-may-call) holds the classification and `reach-access.ts` the reason for each action. After sign-in, a device reaches only a fixed list of paths (the studio page and its assets, `/api`, `/plugins`, `/auth` and `/delorun/reach/status`); every other web route, upgrade and fallback answers `403 LOOPBACK_REQUIRED`, whether or not the route checks anything itself. Under `/api`, an exact route answers a device only when the route admits non-owner callers: the image upload route does, for a chat the policy allows, and the trust bill route does for a read. A full-access approval answered from a device is refused and the prompt stays open for the computer. The phone shows "This needs you at your computer" with the action's name.
- **The loopback routes** for the owner claim, the device list, the approval window, pending requests, approval and removal answer only on the loopback studio, behind the studio's credential, and refuse a `Host` that names a reach address.
- The studio's Devices section lists devices, opens the window and shows the address's state from `GET /delorun/reach/status`.
- **Not built:** the Funnel and relay providers, passkeys, OpenID Connect, the recovery kit, `delorun devices reset`, alerts, and the records of loopback credentials with their idle limit.
- The loopback studio admits upstream's launch token and its stateless `dsh-auth-*` cookies, which expire 30 days after they are minted, have no idle limit and no server-side record, and stay valid until the browser session secret in `.credentials.yaml` changes; Delorun never changes it. Every browser holding such a cookie acts as the one owner. The loopback studio sends no Content Security Policy.

## Exact Fetch routes a device meets

Under `/api`, an exact Fetch route answers a device only when it admits that Peer. Every route of the CLI composition has a decision here, and `delorun/apps/cli/tests/denial/reach/reach-paths.integration.spec.ts` fails on a route without one. A new route is refused unless a device needs it to use a chat it can already read, to send the person to the computer, or because the studio shows it on every page.

| Route | A device | Why |
| --- | --- | --- |
| `/api/session/uploadFileBinary` | Per call | Remote access decides `fileUploads/upload`, which the `reach-device` policy allows, so a phone can attach a file to a chat it may write to. |
| `/api/delorunChatStates.list`, `/api/delorunChatStates.set` | Refused | Snooze and settle states order the chat list at the computer; a device renders every chat without them. |
| `/api/delorunOnboarding.keyTest` | Per page | An approved phone tests its model keys; the answer names each provider and its result and never a key. An approved device is admitted without an unlock, and while PIN mode is on only a page unlocked with the PIN is. The key Remote calls `credentials/describe`, `credentials/set` and `credentials/unset` follow the same rule. |
| `/api/delorunOnboarding.setupRecord` | Refused | What terminal setup recorded serves onboarding at the computer. |
| `/api/delorunOnboarding.addWorkspace` | Refused, `LOOPBACK_ONLY` | Adding a folder as a workspace is workspace management, which the home's computer keeps; onboarding refuses it off the loopback listener before upstream's gate. |
| `/api/delorunNetwork.list`, `/api/delorunNetwork.set` | Refused, `LOOPBACK_REQUIRED` | A workspace's network for its sandboxed commands is read and changed only at the home's computer; the permission defaults refuse both off the loopback listener before upstream's gate. |
| `/api/delorunMainChat.open`, `/api/delorunMainChat.reports` | Refused | Opening the main chat chooses its preset, and the report count marks the computer's sidebar; a device reads the main chat through `session/page`. |
| `/api/delorunTrust.bill` | Read only | The trust badge shows on every studio page, a device's included, and the bill names what runs and what was checked, with no secret. The route admits a device's `GET`. |
| `/api/delorunTrust.check` | Refused | Check now hashes every runtime file and runs the release-log check, which only the home's computer starts. |
| `/api/delorunUpdateCheck.notice` | Refused | The notice names the running release and how many plugins an update would turn off, and an update runs only at the computer. |
| `/api/delorunTrash.*` | Refused | Moving to, restoring from or deleting from the trash is not in the device rule. |
| `/api/delorunPermission.workspaces`, `/api/delorunPermission.review`, `/api/delorunPermission.setFullAccess` | Refused, `LOOPBACK_REQUIRED` | A workspace's full access is a full-access grant, which only the home's computer gives; `@delorun/plugin-permission-defaults` refuses a device before upstream's gate, and the studio there says to turn it on at the computer. |
| `/api/delorunMcpConsent.pending`, `/api/delorunMcpConsent.accept`, `/api/delorunMcpConsent.decline`, `/api/delorunMcpConsent.revoke` | Refused, `LOOPBACK_REQUIRED` | Accepting or revoking a stdio MCP server decides whether its command runs outside the sandbox, which only the home's computer decides; `@delorun/plugin-mcp-consent` refuses a device before upstream's gate. |
| `/api/delorunMcpConsent.waiting` | Admitted, through the route's `admitPeer` | It answers only the names of the servers waiting for the person's OK and what changed, without their commands, arguments, folders or environment, so a phone says to approve them at the computer. |
| `/api/session.export`, `/api/session.markdown`, `/api/plugin-manager/detail-file`, `/api/file`, `/api/present.host`, `/api/present.open`, `/api/changes.summary`, `/api/changes.open`, `/api/changes.diff` | Refused | Upstream declares no device admission, so only the owner reaches them. |

## The rules

### The route

1. The Tailscale private route's serve target is a TCP port on `127.0.0.1`. Tailscale's identity headers are removed before admission and trusted nowhere, the listener checks `Host`, and C4's `Origin` and cookie rules apply as on every reach listener.
2. Arrival fails closed: a request with no listener stamp is a reach request, never a loopback one, and the provider's listener stamps every request. This holds before the provider is built.
3. The route has its own identity factor, `tailnet-membership`. It carries no proof: it states only that the request came through the provider's serve target. The session record stores the factor, and the factor is refused on a Funnel or own-domain address. The provider declares its factor, so a later provider declares its own.

### Sign-in and approval

4. Sign-in is the approved device key alone. On the private route, a valid signature from an approved device over a fresh challenge creates a session; C5's challenge, address binding and `DEVICE_NOT_TRUSTED` refusal hold. There is no passkey and no OpenID Connect on this route.
5. Approval requests are accepted only while an approval window is open. The person opens one at the home's computer, with the loopback studio's "Add a device" or with `delorun devices approve`, which waits. A window lasts 5 minutes and closes at the first approval. Outside a window, `POST /auth/device/request` answers `APPROVALS_CLOSED` without reading the body. A window replaces a standing queue of requests on this route, because every request on it has the same source address, so a limit per source would be one shared limit that any tailnet device could fill.
6. A device is approved only at the home's computer. The approver is a loopback studio session or `delorun devices approve`, which shows the request's label, platform and time, asks for the eight-digit match code shown on the new device, and records the approver as `local`. The home process accepts `devices.approve` only from the person's own command on the home socket, and refuses it for the Host's channel token, which acts for reach sessions.

### What a remote session may do

7. A session on the private route may watch, reply, start chats, approve ordinary prompts and stop a run.
8. It may not, and the home refuses each with `LOOPBACK_REQUIRED`: grant full access, by the per-call escalation or by the per-workspace consent; approve or remove a device; reset the home; use the recovery kit; enrol an identity factor; change reach settings; or change the protection setting of [changes](changes.md). The approval's answer carries the session's factor to the code that grants, so the refusal does not depend on the remote page. The remote studio shows "This needs you at your computer" with the action's name.
9. Installing a plugin from a remote session is therefore not possible: upstream requires a full-access approval for each `plugin_manager` write action.

### Loopback credentials

Rules 10 to 12 are not built: upstream's connection emits `authenticator/minted` and no provider listens to it, so no record, idle limit or reset exists.

10. `@delorun/home-auth` records every loopback credential when upstream's connection mints it (the `authenticator/minted` event, which carries the SHA-256 hash of the credential and never its value), and refuses a loopback credential that verifies but has no record with `401 SESSION_EXPIRED`.
11. A loopback credential expires 7 days after its last use or 30 days after it was minted, whichever comes first, and the rotation events of [C4](../contracts/c04-admission.md#rotation-and-revocation) replace it.
12. `delorun devices reset` replaces the browser session secret in upstream's `.credentials.yaml`, so every loopback cookie minted before it stops working.

### Commands

13. `delorun reach status | on tailscale | off` and `delorun devices list | approve | elevate | remove | code`; `elevate` answers a device's request to unlock sensitive actions ([C14](../contracts/c14-oidc-passkeys.md#elevation)). `delorun reach on tailscale` checks that `tailscale` is installed and running, that the tailnet has HTTPS certificates on, and that the person may run `tailscale serve`; for the last it prints the one command the person runs themselves, and Delorun never runs `sudo`. A home with no owner is claimed through the home socket as the local person.

**The grant model.** A paired device confirms one sensitive action at a time, or opens a Face ID pass with one Face ID, instead of holding an unlock for minutes. The rules are in [C14](../contracts/c14-oidc-passkeys.md#face-id-unlock) and [C4](../contracts/c04-admission.md); this paragraph and the list give the design.

- **One table decides.** `AUTH_CLASSES` puts every Remote method, plugin Fetch route, prompt answer and `/auth` route in one of four classes: `free` (any approved device), `face` (one confirmation for exactly this call), `computer` (only the person at the computer) and `ticket` (a route that needs the enrolment ticket the computer's approval minted). A spec fails on an unlisted action or route, a duplicate row and a row in two classes, so a new route cannot ship without a class.
- **The home keeps the grants.** A grant is a server-side record keyed by device, listener, action and a hash of the call. The browser never sends a token that carries authority: it asks the home for a challenge, confirms with its passkey (or its PIN), and receives a grant id.
- **The home hashes the body.** A Fetch route of class `face` reads the request body itself, up to 1 MiB, hashes method, path, query and body (JSON in canonical form) and looks up the grant under that hash. The client's idea of the hash is never checked, so a grant for one request cannot cover another. A larger body is refused.
- **`Delorun-Grant` carries only the id.** The header names the grant; the home checks it equals the grant it found, uses the grant up and removes the header before the route runs, as it does `Delorun-Unlock`. Grants live 30 seconds and are used once, only after the whole decision allows.
- **Holds keep a terminal or a picker open without a grant per call.** A grant that opens a terminal or the folder picker also opens a hold bound to that terminal's or picker's id, to the device and to the page's connection, with a 5-minute idle cap and a 60-minute total cap. A hold admits follow-up calls on that id; it ends with the device's session, with the device's removal and when the connection closes. Another terminal needs a new grant.
- **A device with a passkey has no other way in than a grant or its own Face ID pass.** Its PIN window, a code typed at the computer and the approval grace admit nothing in class `face`; the PIN still mints a one-action grant and never opens a pass. A device with no passkey keeps what an unlock covers, and every other `face` action needs a one-action grant from its PIN, so no running unlock opens a terminal or a Changes apply.
- **Answers are keyed too.** A prompt answer that grants more authority is admitted by a grant for the agent, call id, grants marker and answer value, or by a live Face ID pass.
- **Computer-only stays computer-only.** Approving or removing a device from a device that holds no passkey, the PIN, remote access and the settings document are class `computer`. Removing another device needs a grant from a device that holds a passkey, which no pass replaces.

## What this does not protect against

- **An approved, unlocked phone.** Its holder has the chats and can drive the agent within what was already granted at the computer. The limit is partial: a workspace that the person put on full access at the computer can still be driven from the phone, and a command run there can do anything the person's user can, including writing the device records. The protections are the phone's own lock, removing the device at the computer, and the remote session's idle timeout.
- **Script in the loopback studio.** Script injected into the loopback studio can open a window and approve a device, which on this route then needs no second factor. Delorun sets no content security policy of its own on the loopback studio.
- **Tailscale.** Tailscale can add a device to the tailnet unless Tailnet Lock is on, and it holds the `ts.net` certificate's key. An added device still needs an approval at the home's computer.
- **Where a request comes from.** Every request on the route has the source `127.0.0.1`, so the home cannot verify the origin of an approval request. Any tailnet device can ask while a window is open; the match code binds an approval to the device whose screen the person reads, and nothing shows who holds that device.
- **The start token.** Approval at the computer rests on the agent being unable to read the start token (C1's confinement of its commands). A process of the person's user outside the sandbox can read the token and, over the update channel, open the approval window and approve a pending request with its match code, cancel requests, remove devices and obtain a fresh studio sign-in link. When it also controls a device that asks, it approves that device with nobody present.
- **A home process that stops without cleaning up.** `tailscaled` keeps forwarding the address to the fixed port until the next start or `delorun reach off`. Another local user who binds that port in that time is served to the phone's origin ([C7](../contracts/c07-reach-providers.md#what-this-does-not-prove)).
- **No outside review.** No outside security review of this design or of reach has happened.

## Denial tests

- `an unapproved device on the tailnet route gets no session`
- `a request outside a window is refused unread`
- `a request without a listener stamp is not loopback`
- `a tailnet-route session cannot approve a device`
- `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent`
- `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach`
- `the channel token cannot call devices.approve`
- `a forged Tailscale-User-Login changes nothing`
- `a foreign Host on the serve target is refused`
- `owner claim on the tailnet route is refused`
- `tailnet-membership is refused on a Funnel or own-domain address`
- `idle and absolute limits refuse a loopback credential` (not built)
- `a loopback credential without a record is refused` (not built)
- `a loopback cookie minted before devices reset is refused after it` (not built)

## Never run on a real tailnet or phone

The specs fake `tailscale` and drive the fixed port over loopback. These have never run against a real tailnet or phone:

- the real output of `tailscale serve status --json`, as `readServeRules` reads it;
- the Funnel fields of that output, for Funnel detection and refusal;
- `--https=<port> off` on older Tailscale clients, which may take another form;
- foreground `tailscale serve` sessions, which `readServeRules` reads and does not create;
- the sign-in page in a real phone browser: the IndexedDB device key, WebCrypto signing and the Content Security Policy;
- the studio on a phone under the allowlist;
- the refused-answer notice for a full-access prompt;
- image upload from a phone;
- the 24-hour token roll on a phone;
- the Devices section with a real launch cookie;
- the cost of a 1,000-chat list on a real phone page.

## Implementation status

Fundamentals F11, F12 and F13 name the built refusals ([fundamentals](../security/fundamentals.md)). Passkeys, OpenID Connect, the recovery kit, reset, alerts, the Funnel and relay providers and the loopback credential records are not built.

Open follow-ups:

- `@delorun/reach` reads only the serve rule on its own address and port, so another serve port or a TCP forward to the listener port goes unnoticed, and it keeps serving after repeated unreadable `tailscale serve status` output.
- The loopback credential records of rules 10 to 12.
- The Gateway decides whether a non-owner Peer receives and may answer a forwarded waterfall on the global resource, not on the chat that raised it.
