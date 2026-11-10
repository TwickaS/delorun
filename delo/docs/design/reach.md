---
description: "Design of reach on the person's own tailnet: device approval only at the home's computer through a short approval window, sign-in with the approved device key, what a remote session may and may not do, and the limit that stays."
---

# Reach on your own tailnet

English

## Summary

Reach lets a person open their studio from their own phone or laptop over their own Tailscale tailnet, with no Delo service in the path. A new device is approved only at the home's computer, during a short approval window the person opens there. An approved device signs in with its device key. A remote session can watch, reply, start chats, approve ordinary prompts and stop a run; it cannot grant full access, approve or remove a device, or change reach or protection. Those wait until the person is at the computer, and the home refuses them, not the remote page. The admission rules are [contract C4](../contracts/c04-admission.md), device approval [contract C5](../contracts/c05-device-approval.md), the reach providers [contract C7](../contracts/c07-reach-providers.md) and the identity factors [contract C14](../contracts/c14-oidc-passkeys.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- `@delo/home-auth` serves three routes, each answered only on the loopback studio: the owner claim with a single-use owner code, the device list, and device removal, which ends the device's sessions and closes its reach connections. A claim that arrives on a reach listener, or whose `Host` names a reach address, is refused with `OWNER_CLAIM_LOOPBACK_ONLY` and claims nothing. The device list and removal refuse a `Host` that names a reach address, and removal refuses a request from another origin.
- A request that no listener stamped is read as a loopback arrival. The routes above also require a loopback `Host`, so such a request that names a reach address is still refused.
- There is no sign-in route, no device approval, no reach listener, and no `delorun reach` or `delorun devices` command. Setup records reach as off: `--yes` leaves it off, and a `--config` document that names any reach option other than `none` is refused.

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

### Commands

10. `delorun reach status | on tailscale | off` and `delorun devices list | approve | remove | code`. `delorun reach on tailscale` checks that `tailscale` is installed and running, that the tailnet has HTTPS certificates on, and that the person may run `tailscale serve`; for the last it prints the one command the person runs themselves, and Delo never runs `sudo`. A home with no owner is claimed through the home socket as the local person.

## What this does not protect against

- **An approved, unlocked phone.** Its holder has the chats and can drive the agent within what was already granted at the computer. The limit is partial: a workspace that the person put on full access at the computer can still be driven from the phone, and a command run there can do anything the person's user can, including writing the device records. The protections are the phone's own lock, removing the device at the computer, and the remote session's idle timeout.
- **Script in the loopback studio.** Script injected into the loopback studio can open a window and approve a device, which on this route then needs no second factor. Delo sets no content security policy of its own on the loopback studio.
- **Tailscale.** Tailscale can add a device to the tailnet unless Tailnet Lock is on, and it holds the `ts.net` certificate's key. An added device still needs an approval at the home's computer.
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

## What is built so far

The loopback-only owner claim, device list and device removal are built, and fundamental F11 records them as enforced ([fundamentals](../security/fundamentals.md)). Sign-in, the approval window, local approval, the `tailnet-membership` factor, fail-closed arrival, the refusals of a remote session, the provider and the commands are not built; fundamentals F12 and F13 record them as designed.
