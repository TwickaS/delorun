---
description: "Contract C14: the identity factors a reach address can use, passkey relying-party IDs per address with the ts.net rule both ways, the person's own OpenID Connect provider with client registration and redirect URIs per address, required claims, audience per home, the owner identity pinned at its first enrolment, nonce, PKCE, issuer checks and mix-up protection, signing key IDs and rotation, and the Delo Run issuer as a fast-follow."
---

# Contract C14: OpenID Connect and passkeys

English | [中文](c14-oidc-passkeys.zh.md)

<a id="summary"></a>
## Summary

Reach asks for an identity factor in addition to device approval: a passkey, or a sign-in at the person's own OpenID Connect provider. The home is the relying party for both. This page defines which factors each reach address can use, the passkey relying-party ID of each address, how the home registers as a client at the person's provider, the authorization flow with its nonce, PKCE and issuer checks, the claims and audience the home requires, the owner identity it pins, how it fetches and rotates signing keys, and the rules that bind the Delo Run issuer, a fast-follow. A factor never replaces device approval ([C5](c05-device-approval.md)). The types package [`@delo/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.md) carries the rules, claims, codes and limits.

<a id="status"></a>
## Status

The passkey and OpenID Connect factors on this page are not built: the home has no passkey relying party and no OpenID Connect client. The `tailnet-membership` factor of the Tailscale private route is built.

- **Built and reached:** setup's answers schema names `reach.identityFactor` and refuses any value other than `null` in a `--config` document ([C11](c11-setup-answers.md)).
- **Not built:** passkey enrolment and assertion with user verification and counters; client registration at the person's provider; the authorization flow with `state`, `nonce`, PKCE and issuer checks; ID token checks and signing-key rotation; the pinned owner subject; re-authentication; the Delo Run issuer.

The requirements and denial tests below that this list names as not built or reached by nothing protect no one until a change builds and wires them. The [reach design](../design/reach.md) states that the private tailnet route signs in with the approved device key alone, with no passkey or OpenID Connect; where this page lists an identity factor for `tailscale-private`, the design supersedes it.

<a id="contents"></a>
## Contents

- [Summary](#summary)
- [Status](#status)
- [Contract](#contract)
  - [Relying-party IDs](#relying-party-ids)
  - [Enrolment](#enrolment)
  - [Passkeys](#passkeys)
  - [Client registration](#client-registration)
  - [Authorization flow](#authorization-flow)
  - [ID token checks](#id-token-checks)
  - [Owner subject](#owner-subject)
  - [Re-authentication](#re-authentication)
  - [Signing keys](#signing-keys)
  - [Tailnet identity](#tailnet-identity)
  - [Tailnet membership](#tailnet-membership)
  - [What a device may call](#what-a-device-may-call)
  - [Limits](#limits)
  - [Errors](#errors)
  - [Delo Run issuer](#delo-run-issuer)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
  - [What this does not prove](#what-this-does-not-prove)
- [Decided values](#decided-values)

<a id="contract"></a>
## Contract

<a id="relying-party-ids"></a>
### Relying-party IDs

Every rule is per studio address: a passkey or a redirect URI of one address is never accepted on another.

| Address | Passkeys | Passkey relying-party ID | OpenID Connect redirect URI |
| --- | --- | --- | --- |
| Loopback | Not used: the loopback listener needs no identity factor | — | — |
| Tailscale private, `https://<machine>.<tailnet>.ts.net[:<port>]` | Current contract: not available; the address signs in with [tailnet membership](#tailnet-membership) | — | Not built in `0.1.0` |
| Tailscale Funnel, `https://<machine>.<tailnet>.ts.net[:<port>]` | Current contract: not available | — | `https://<address>/auth/oidc/callback` |
| Own domain, `https://<name>` | Available | `<name>`, the address's host exactly | `https://<name>/auth/oidc/callback` |

`<address>` is the address's host with its port when the port is not 443. On the Tailscale private address the identity factor is [tailnet membership](#tailnet-membership), and no OpenID Connect sign-in is built for it, because enrolling one from a phone would pin the owner identity from the weaker session. On a Funnel address under the current contract, the person's OpenID Connect provider is the identity factor, and setup and the reach screens say that passkeys are not available on that address.

- **The ts.net rule, current contract.** Passkeys are not available on `ts.net` addresses. This holds until a spike result recorded under [compatibility](#compatibility) shows otherwise.
- **The ts.net rule, adopted by a passing spike.** The relying-party ID of a `ts.net` address is its host, `<machine>.<tailnet>.ts.net`. A Tailscale private address and a Funnel address of the same machine share that host and so share a relying-party ID; the home therefore binds each passkey to the address it was enrolled on and refuses an assertion whose `clientDataJSON.origin` is not that address.
- **Never a parent domain.** A relying-party ID is never a parent of the address's host, such as `example.com` for `studio.example.com` or `<tailnet>.ts.net`, so a passkey is usable on one host only.

<a id="enrolment"></a>
### Enrolment

The identity factor of an address is enrolled when the address is added. A device approved for an address that has no enrolled factor receives an enrolment session: a C4 session ([C4](c04-admission.md#sessions)) with a 10-minute absolute limit that is admitted only to `POST /auth/passkey/register/options`, `POST /auth/passkey/register`, `GET /auth/oidc/start` with `purpose=enrol` and `GET /auth/oidc/callback`. Completing an enrolment ends the enrolment session and is a sign-in factor change, which rotates every session. The home issues the recovery kit at the first enrolment of a passkey or OpenID Connect sign-in ([C5](c05-device-approval.md#recovery-kit)).

<a id="passkeys"></a>
### Passkeys

- **Registration options.** `POST /auth/passkey/register/options` returns `rp` `{ id: <relying-party ID>, name: "Delo" }`; `user` `{ id: <the home's owner handle>, name: "owner", displayName: <device label> }`, where the owner handle is 32 random bytes fixed per home; `pubKeyCredParams` EdDSA (-8), ES256 (-7) and RS256 (-257); `authenticatorSelection` `{ residentKey: "required", userVerification: "required" }`; `attestation: "none"`; `excludeCredentials` listing this address's credentials; a 32-byte challenge; and a timeout of 300,000 milliseconds.
- **Storage.** `~/.delo/secrets/home-auth/passkeys.json` holds, per credential, the credential id, the COSE public key and algorithm, the address, the relying-party ID, the signature counter, the transports, the creation time and the enrolling device id.
- **Assertion options.** `POST /auth/passkey/options` returns a 32-byte challenge, the relying-party ID of the listener's address, `allowCredentials` listing that address's credentials and `userVerification: "required"`.
- **Assertion checks.** The home accepts an assertion only when `clientDataJSON.type` is `webauthn.get`; its challenge is one the home issued, unused and unexpired; its origin equals the listener's address exactly; `rpIdHash` equals the SHA-256 hash of that address's relying-party ID; the user-present and user-verified flags are set; the credential is enrolled for that address; the signature verifies with the stored key; and a non-zero stored counter is less than the presented counter, which the home then stores.
- **Challenges.** A passkey challenge expires after 5 minutes and is single-use.

<a id="client-registration"></a>
### Client registration

During setup, or when the person turns reach on, the person registers Delo as a client at their own OpenID Connect provider and enters three values: the issuer URL, the client ID and the client secret. Setup lists the redirect URIs to register, one `https://<address>/auth/oidc/callback` for each `ts.net` and own-domain address of the home.

- **Discovery.** The home reads `<issuer>/.well-known/openid-configuration` over `https`. The document's `issuer` must equal the entered issuer exactly, `response_types_supported` must include `code`, `code_challenge_methods_supported` must include `S256`, and `id_token_signing_alg_values_supported` must include an algorithm of [ID token checks](#id-token-checks); otherwise setup refuses with the matching code.
- **Dynamic registration.** Only when the provider's metadata has a `registration_endpoint` and the person chooses it, the home registers itself as RFC 7591 describes: `client_name` `Delo`, the redirect URIs above, `grant_types` `["authorization_code"]`, `response_types` `["code"]`, `token_endpoint_auth_method` `client_secret_basic` and `application_type` `web`, with an initial access token when the provider requires one and the person enters it.
- **Storage.** `~/.delo/secrets/home-auth/oidc-client.json` holds the issuer, client ID, client secret, redirect URIs and, after dynamic registration, the registration access token. No configuration row holds them.
- **One client per home.** A home's client registration is its own: two homes never share a client ID, so the client ID is the audience that names the home.
- **Adding an address.** Adding an address adds its redirect URI at the provider: the person adds it, or the home updates a dynamic registration through its registration access token.

<a id="authorization-flow"></a>
### Authorization flow

1. **Start.** `GET /auth/oidc/start` with `purpose` (`enrol`, `sign-in`, `recovery` or `reauth`) and the device id creates a flow bound to the listener's address: a 32-byte `state`, a 32-byte `nonce`, a 32-byte PKCE `code_verifier`, the issuer, the purpose, the device id and the creation time. The home holds the flow in memory, sets the cookie `__Host-delo-oidc` to a 32-byte random value whose hash the flow records, and redirects to the issuer's `authorization_endpoint` with `response_type=code`, `client_id`, the address's `redirect_uri`, `scope=openid`, `state`, `nonce`, `code_challenge` (the SHA-256 hash of the verifier) and `code_challenge_method=S256`. For `reauth`, it adds `prompt=login` and `max_age=0`, and `nonce` is the approval hash the device sends.
2. **Callback.** `GET /auth/oidc/callback` is accepted only when `state` names a pending, unexpired flow of this address and the `__Host-delo-oidc` cookie matches the flow. When the provider's metadata sets `authorization_response_iss_parameter_supported`, the response must carry `iss` equal to the flow's issuer (RFC 9207); an `iss` that is present must equal it in every case. The flow is consumed at the callback, whatever its result.
3. **Token request.** The home sends the code and the `code_verifier` to the `token_endpoint` of the flow's issuer, read from that issuer's metadata and never from the response, with `client_secret_basic`.
4. **Result.** After the [ID token checks](#id-token-checks), the home issues a sign-in ticket: 32 random bytes, single-use, valid for 60 seconds, bound to the flow's device id, address and purpose, which the device presents as its factor proof ([C5](c05-device-approval.md#sign-in)). The home stores no ID token and requests no refresh token.

<a id="id-token-checks"></a>
### ID token checks

| Check | Rule |
| --- | --- |
| Algorithm | `RS256`, `PS256`, `ES256` or `EdDSA`. `none` and every `HS*` algorithm are refused. |
| Key | The header carries `kid`, which names a key of the flow issuer's key set ([signing keys](#signing-keys)); the signature verifies with that key. |
| `iss` | Equals the flow's issuer exactly. |
| `aud` | Contains the home's client ID. When `aud` has more than one value, `azp` equals the client ID. |
| `exp` | Later than the home's clock, with 60 seconds of skew. |
| `iat` | Within 10 minutes before the home's clock, with 60 seconds of skew. |
| `nonce` | Equals the flow's nonce. |
| `sub` | Present. For `sign-in`, `recovery` and `reauth`, `iss` and `sub` equal the owner's pinned identity. |
| `auth_time` | Required for `reauth`, and within 120 seconds of the home's clock. |

The required claims are therefore `iss`, `sub`, `aud`, `exp`, `iat` and `nonce`, and `auth_time` for `reauth`. A token that fails a check is refused with its code and creates no ticket.

<a id="owner-subject"></a>
### Owner subject

The owner's identity at the person's provider is pinned when the owner claims the identity factor: the first OpenID Connect enrolment, made by a device of the owner ([C5](c05-device-approval.md#owner-claim)), records the issuer and `sub` in `~/.delo/secrets/home-auth/owner.json`. Every later sign-in, recovery and re-authentication must present that pair, and so must an `enrol` flow for another address. Changing it is a sign-in factor change, accepted only from a trusted device in a live session after an `enrol` flow at the new identity; it rotates every session ([C4](c04-admission.md#rotation-and-revocation)). `delorun devices reset` removes the pin ([C5](c05-device-approval.md#reset)).

<a id="re-authentication"></a>
### Re-authentication

On an address without passkeys, a device approval carries an OpenID Connect re-authentication ([C5](c05-device-approval.md#approval)): a `reauth` flow whose `nonce` is the approval hash, with `prompt=login` and `max_age=0`. The home accepts its ID token as the approval's `oidcReauth` only after the checks above, with `auth_time` within 120 seconds and the owner's pinned identity.

<a id="signing-keys"></a>
### Signing keys

- **Key set.** The home reads the issuer's JSON Web Key Set from the `jwks_uri` of the issuer's metadata over `https`, at most 65,536 bytes, within 10 seconds. A key without `kid`, or with a `use` other than `sig`, is ignored.
- **Rotation.** The home refreshes the key set every 24 hours, and when a token names an unknown `kid`, at most once every 5 minutes. A token whose `kid` is still unknown after a refresh is refused with `OIDC_UNKNOWN_KEY`. A key the issuer removes from its set stops verifying tokens at the next refresh.
- **Metadata.** The home refreshes the issuer's metadata every 24 hours with the same size and time limits, and refuses metadata whose `issuer` changed.

<a id="tailnet-identity"></a>
### Tailnet identity

The `tailnet` identity factor exists only under C7's socket variant ([C7](c07-reach-providers.md#identity-headers)): a request on the serve socket whose `Tailscale-User-Login` is on the tailnet login allowlist proves the factor for `tailscale-private`. Under the current contract it is refused with `TAILNET_IDENTITY_UNAVAILABLE`. The recovery kit never accepts it ([C5](c05-device-approval.md#recovery-kit)).

<a id="tailnet-membership"></a>
### Tailnet membership

The `tailnet-membership` factor carries no proof: it states that a request came through the serve target of a reach provider that declares the factor. Only the `reach-tailscale-private` provider may declare it ([C7](c07-reach-providers.md#provider-service-definition)), and the home refuses the declaration with `TAILNET_IDENTITY_UNAVAILABLE` for any other listener and for any address that is not a `ts.net` address. On that listener a fresh device-key signature of an approved device alone creates a full session ([C5](c05-device-approval.md#sign-in)), and the session record carries the factor ([C4](c04-admission.md#sessions)).

The home refuses a session whose factor is `tailnet-membership` with `403 LOOPBACK_REQUIRED` for each action granted only at the home's own computer: granting full access, whether an escalation to `danger-full-access` (including `plugin_manager`'s) or a workspace's full-access consent; granting a prompt marked `workspace-management` (the main chat's workspace tools and its other asks, and instruction-layer writes); allowing, declining or revoking the start of a stdio MCP server, of which a device reads only the names of the waiting servers and what changed in each; opening the approval window and approving or removing a device; reset; the recovery kit; enrolling an identity factor; and changing reach settings. The home refuses where the action is granted, not the client: an approval prompt that grants full access carries `grants: "full-access"`, and the answer of a Peer admitted with this factor is not applied, so the prompt stays open for the studio on the home's own computer. The remote studio says to approve the action at the computer. Watching, replying, starting chats, answering every other prompt and stopping a run are allowed, so a plugin cannot be installed from a phone. The same rule holds for every Remote method the studio calls: the device's Peer speaks for its `reach-device` principal, whose remote access policy allows the methods and forwarded events of [what a device may call](#what-a-device-may-call) and refuses every other with `remote-access/denied` and the reason `loopback-required: <action>`; the policy and its two tables live in [`@delo/home-auth`](../../packages/home-auth/README.md).

<a id="what-a-device-may-call"></a>
### What a device may call

The owner's rule for a device is that a person at their phone can do what they do at their computer, except where an action needs a decision the computer is there to make. `@delo/home-auth` sorts every Remote method and every forwarded event of Delo's default profile into one of three classes, and the reach access denial suite fails on an action neither table names and on a table entry that names none.

- **Allowed**: the device does what the person does at the computer. The actions, with the reason for each, are `REACH_ALLOWED_ACTIONS` in [`reach-access.ts`](../../packages/home-auth/src/reach-access.ts).
- **Reserved to the home's own computer**: refused with `403 LOOPBACK_REQUIRED` and the reason `loopback-required: <action>`. The actions, with the reason for each, are `REACH_DENIED_ACTIONS` in the same file.
- **A grant the computer alone gives**: refused wherever it is granted rather than where it is called ([tailnet membership](#tailnet-membership)).

| Family | Actions | Class | Why |
| --- | --- | --- | --- |
| Chats, workspaces, jobs, goals and schedules, read | `session/*` reads, `workspace/follow`, `job/*`, `goals/get`, `schedule/*` reads | Allowed | Reading a chat, a workspace or a schedule reaches no secret and changes no run. |
| Chats, write | `session/create`, `session/fork`, `session/prompt`, `session/updateQueue`, `session/cancel`, `session/rename`, `workspace/pinSession`, `workspace/unpinSession`, `fileUploads/upload`, `userQuestions/answer`, `subagents/*` | Allowed | Replying, stopping a run, answering a question and organizing the chat list are what the person does at the computer. |
| Agent preset | `agentPresets/list`, `agentPresets/read`, `agentPresets/select` | Allowed | A preset decides the plugins and tools a chat that has not started runs with. Choosing one grants no access by itself: a workspace's full-access consent is still the computer's answer, and every approval prompt still applies. |
| Files of a chat's workspace | `workspaceFiles/list`, `workspaceFiles/read`, `workspaceFiles/readBytes`, `workspaceFiles/stat`, `officeToPdf/render`, `officeToPdf/generation`, `fileReferences/list` | Allowed, relative paths only | The workspace-file service is read-only, caps every page, window, complete file and listing, checks the file kind and refuses a final symlink. It confines a listed directory to the workspace root, and a file read is admitted only when the call names a relative path that does not walk out of the workspace. |
| Settings and models, read | `settings/describe`, `permissionPresets/catalog`, `llm/listProviders`, `llm/listConfigurableProviders`, `session/modelCatalog` | Allowed | The redacted settings and the provider names carry no secret. |
| Plugins and profile history, read | `pluginManager/listPlugins`, `listBundles`, `listVersionExemptions`, `listVersions`, `readBundleDetail`, `inspect`, `registries`, `history`, `waitForInstall`, `pluginInventory/list`, `pluginRegistryProbe/fastest` | Allowed | A device shows what is installed and what changed; every action that installs, enables, removes or reverts stays reserved. |
| Forwarded events, read | `event:api-session/*`, `event:commands/change`, `event:goal/*`, `event:llm/*`, `event:permission-presets/*`, `event:settings/document-updated`, `event:schedule/changed`, `event:agent-preset/selected`, `event:plugin-manager/changed`, `event:plugin-market/changed` | Allowed | A refresh signal for a surface the device may already read. |
| Approval prompt | `event:approval/request` | Allowed, except a grant | The answer guard refuses an answer that grants full access or workspace management ([tailnet membership](#tailnet-membership)). |
| Plugins and profile history, write | `pluginManager/installBundle`, `updateBundle`, `removeBundle`, `setBundleEnabled`, `setPluginEnabled`, `setVersionExemption`, `cancelInstall`, `undo`, `restore` | Reserved | Plugin management installs or enables code that runs in the Host outside any sandbox, and profile history can turn a guard plugin off. |
| Settings, write | `settings/mutate`, `settings/replace`, `settings/update`, `settings/openSettingsDocument`, `session/selectModel`, `session/initializeDefaultModel` | Reserved | A settings write changes the Host's configuration, and no settings namespace is writable from a device. |
| Credentials and account | `credentials/*`, `llm/discoverModels`, `account/*`, `event:credentials/*`, `event:deepseek-account/*` | Never | Credentials are the home's secrets, and account sign-in is the person's own. |
| Terminals, folders and the computer | `terminal/*`, `directoryPicker/*`, `session/openWorkspacePath`, `session/workspacePathApplications` | Reserved | A terminal is a shell outside the sandbox, the folder picker browses the computer, and the rest opens an application on it. |
| Workspaces and the chat list | `workspace/create`, `workspace/delete`, `workspace/initializeDefault`, `workspace/insertBefore`, `workspace/rename`, `workspace/archiveSession`, `workspace/unarchiveSession`, `workspace/insertSessionBefore`, `workspaceFiles/changes` | Reserved | Registering or removing a folder and the Changes surface's working tree are the computer's, and archiving or reordering chats is not in the device rule. |
| Slash commands, goals and schedules, write | `commands/execute`, `goals/create`, `goals/edit`, `goals/pause`, `goals/resume`, `goals/complete`, `goals/clear`, `schedule/create`, `schedule/edit`, `schedule/run`, `schedule/deleteInactive` | Reserved | A slash command can change settings, plugins or the profile, and a scheduled follow-up runs prompts later with no person present. |
| Dynamic plugin code | `dynamicCordisRunner/*`, `event:cordis/*` | Reserved | It runs model-authored plugin code in the Host. |
| Feedback | `sessionFeedback/record`, `messageFeedback/*` | Reserved | Feedback leaves the home, and Delo turns it off. |
| A grant | A full-access escalation, a workspace's full-access consent, a `workspace-management` prompt | Never | The workspace's consent and the escalation are the person's answer at the computer, whatever the device is allowed to call. |

<a id="limits"></a>
### Limits

| Limit | Value |
| --- | --- |
| Flow `state`, `nonce` and `code_verifier` | 32 random bytes each |
| Flow lifetime | 10 minutes, single use |
| Pending flows per home | 20 |
| Sign-in ticket | 32 bytes, 60 seconds, single use |
| Passkey challenge | 32 bytes, 5 minutes, single use |
| Passkey registration timeout | 300,000 milliseconds |
| Enrolment session | 10 minutes |
| ID token clock skew | 60 seconds |
| ID token `iat` age | 10 minutes |
| Re-authentication `auth_time` age | 120 seconds |
| Key set and metadata | 65,536 bytes, 10-second timeout, refreshed every 24 hours |
| Unknown `kid` refresh | at most once every 5 minutes |

<a id="errors"></a>
### Errors

| Code | Raised when |
| --- | --- |
| `OIDC_DISCOVERY_FAILED` | The metadata cannot be read, exceeds its limit or names another issuer. |
| `OIDC_PKCE_UNSUPPORTED` | The metadata does not list `S256`. |
| `OIDC_ALGORITHM_UNSUPPORTED` | No allowed signing algorithm is listed, or a token uses another. |
| `OIDC_STATE_INVALID` | An unknown, used or expired `state`, or a missing or different `__Host-delo-oidc` cookie. |
| `OIDC_ISSUER_MISMATCH` | An `iss` response parameter or token `iss` other than the flow's issuer, or a missing required `iss` parameter. |
| `OIDC_AUDIENCE_MISMATCH` | `aud` without the client ID, or several audiences without `azp` equal to it. |
| `OIDC_NONCE_MISMATCH` | A `nonce` other than the flow's. |
| `OIDC_TOKEN_EXPIRED` | `exp` passed or `iat` too old. |
| `OIDC_UNKNOWN_KEY` | A missing `kid`, or one unknown after a refresh. |
| `OIDC_SIGNATURE_INVALID` | A signature that does not verify. |
| `OIDC_SUBJECT_MISMATCH` | `iss` and `sub` other than the owner's pinned identity. |
| `OIDC_REAUTH_TOO_OLD` | `auth_time` missing or older than 120 seconds on `reauth`. |
| `OIDC_PROVIDER_ERROR` | The provider answered with an error. |
| `PASSKEY_UNAVAILABLE` | A passkey on an address where passkeys are not available. |
| `PASSKEY_ASSERTION_INVALID` | An assertion that fails a check, including another address's relying-party ID or origin. |
| `PASSKEY_USER_VERIFICATION_REQUIRED` | The user-verified flag is not set. |
| `PASSKEY_COUNTER_REGRESSED` | A counter that did not increase. |
| `TAILNET_IDENTITY_UNAVAILABLE` | The `tailnet` factor outside C7's socket variant, or `tailnet-membership` declared for a listener or address other than the Tailscale private one. |
| `LOOPBACK_REQUIRED` | A session whose factor is `tailnet-membership` answers a prompt or sends a request for an action granted only at the home's own computer ([tailnet membership](#tailnet-membership)). |

<a id="delo-run-issuer"></a>
### Delo Run issuer

The Delo Run issuer, which lets a person sign in with a Delo Run account, is a fast-follow and comes with the Delo relay: Delo 1.0 configures no Delo Run issuer. When it is added, it follows every rule of this page as a second issuer, and also these:

- Its redirect URI is `https://<address>/auth/oidc/callback/delo-run`, so it never shares a redirect URI with the person's provider.
- It signs ID tokens with asymmetric keys only, every token header carries `kid`, and it publishes a key set.
- It publishes a new signing key in its key set at least 24 hours before it signs with it, and keeps a retired key there for at least 24 hours after its last use.
- Its signing private keys are Cloudflare Worker secrets, never in a repository, a configuration file or a log.
- Its audience is the client ID Delo Run assigns to each home.

<a id="consumers"></a>
## Consumers

- `delo/packages/home-auth/src/identity/`: the passkey relying party, the OpenID Connect relying party, enrolment and the `tailnet` factor.
- `delo/packages/home-auth/`: sign-in tickets in session creation, approvals' re-authentication and the owner record.
- Setup in `delo/apps/cli/`: client registration, dynamic registration and the redirect URI list.
- `delo/packages/plugin-reach-ui/`: enrolment screens and the statement that passkeys are not available on an address.
- `delo/packages/contract-oidc-passkeys/`: the rules, claims, codes and limits.
- [C4](c04-admission.md) for the routes and sessions, [C5](c05-device-approval.md) for the factor proofs, [C7](c07-reach-providers.md) for the addresses.

<a id="compatibility"></a>
## Compatibility

The spike result on passkey relying-party IDs on `ts.net` is not recorded on this page, so passkeys are not available on `ts.net` addresses, and OpenID Connect sign-in is their identity factor. A passing spike result makes passkeys available on `ts.net` addresses, with the relying-party ID of [the adopted rule](#relying-party-ids), by a change to this section that records the report's evidence:

1. Whether `ts.net` is on the Public Suffix List, with the list's version.
2. The relying-party ID a page on a Tailscale private address and on a Funnel address may use.
3. For current releases of Chromium, Firefox and Safari, each with its version and operating system: whether a passkey registers and asserts there, with a platform authenticator and with a security key.
4. Whether a passkey registered on the private address's origin asserts on the Funnel address's origin of the same machine, so the home's per-address binding is the control that separates them.

When passkeys fail in any of those browsers, the current contract stays. Adding a redirect URI form, an algorithm or a claim requirement is a change to this contract; removing an algorithm that enrolled passkeys use is a sign-in factor change for the passkeys it affects.

<a id="security"></a>
## Security

Requirements:

- Every passkey and redirect URI is bound to one studio address: relying-party IDs are the address's host, never a parent, and an assertion carries that address's origin.
- Passkeys require user verification, and their counters never decrease.
- The audience is the home's own client ID; a token with several audiences needs `azp` equal to it.
- The owner's issuer and subject are pinned at the first enrolment, and every later sign-in, recovery and re-authentication must match them.
- Every flow carries a single-use `state` bound to the browser, a `nonce` and an S256 PKCE verifier.
- The token endpoint, key set and issuer of a flow come from the flow's issuer only; an `iss` parameter or token `iss` from another issuer is refused.
- ID tokens are signed with an asymmetric algorithm under a `kid` from the issuer's key set, which the home refreshes on a fixed interval and on an unknown key.
- Dynamic registration is used only when the provider advertises it and the person chooses it.
- The client secret lives in a secret file, never in a configuration row.
- `tailnet-membership` is declared only for the Tailscale private address, and a session with it is refused every action of the home's own computer where the action is granted.

Denial tests:

| Test name | Behaviour proven |
| --- | --- |
| `a token from issuer B in a flow started with issuer A is refused` | Against two issuer stand-ins, a callback carrying issuer B's code, `iss` parameter or ID token in a flow started with issuer A is refused with `OIDC_ISSUER_MISMATCH`, and no ticket is issued. |
| `a wrong-audience token is refused` | A correctly signed token whose `aud` lacks the client ID, or has several audiences without `azp` equal to it, is refused with `OIDC_AUDIENCE_MISMATCH`. |
| `a forged token is refused` | Tokens with `alg` `none`, with `HS256` keyed by the issuer's public key, or with a signature by an unknown key are refused. |
| `a token without a known kid is refused` | A token without `kid`, or with a `kid` that a refresh does not find, is refused with `OIDC_UNKNOWN_KEY`. |
| `a replayed state or foreign browser is refused` | A callback reusing a consumed `state`, or arriving without the flow's `__Host-delo-oidc` cookie, is refused with `OIDC_STATE_INVALID`. |
| `a wrong nonce or verifier fails` | A token whose `nonce` differs is refused, and a token request with another `code_verifier` gets no token from the stand-in. |
| `another subject is refused` | A valid token for a `sub` other than the pinned one creates no sign-in ticket. |
| `a passkey assertion for another address's relying-party ID is refused` | An assertion made for one address's relying-party ID, presented on another address, is refused with `PASSKEY_ASSERTION_INVALID`. |
| `a passkey without user verification is refused` | An assertion without the user-verified flag is refused. |
| `a regressed counter is refused` | An assertion whose counter is not greater than a non-zero stored counter is refused. |
| `a passkey on a ts.net address is refused under the current contract` | Passkey registration and assertion options on a `ts.net` address answer `PASSKEY_UNAVAILABLE`. |
| `tailnet-membership is refused on a Funnel or own-domain address` | A provider that declares `tailnet-membership` for the Funnel listener or an own-domain address is refused with `TAILNET_IDENTITY_UNAVAILABLE`. |
| `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent` | An `allowed-once` answer from a `tailnet-membership` session to a prompt that grants full access is refused with `LOOPBACK_REQUIRED`; the escalated call does not run and the workspace records no consent, and the same prompt answered on the loopback studio grants. |
| `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach` | Each such request from a `tailnet-membership` session is refused, and the home's devices and reach state are unchanged. |
| `a stale re-authentication is refused` | A `reauth` token with `auth_time` older than 120 seconds, or with a `nonce` other than the approval hash, does not approve. |
| `a device chooses the preset a chat that has not started runs with` | `agentPresets/select` from a `reach-device` Peer returns the chosen preset and the chat records `agent-preset/selected`; a preset that names full access still meets the workspace's consent refusal, which is granted only at the computer. |
| `a device reads the files of its chat's workspace and no path outside it` | `workspaceFiles/list`, `read`, `readBytes` and `stat` succeed for a relative path inside the Session's workspace and are refused with `loopback-required: <action> with a path outside the chat's workspace` for an absolute path and for a relative one that walks out of it; `workspaceFiles/changes` stays refused. |
| `a device reads the installed plugins and cannot change them` | `pluginManager/listPlugins`, `listBundles`, `registries`, `history` and `pluginInventory/list` succeed, and `installBundle`, `setPluginEnabled`, `setBundleEnabled`, `removeBundle` and `undo` are refused with `loopback-required: <action>`. |

<a id="what-this-does-not-prove"></a>
### What this does not prove

- **User verification under `attestation: "none"`.** The home reads the user-verified flag the authenticator sets and does not verify the authenticator, so the flag is only as trustworthy as the authenticator that made the assertion.
- **The person's provider.** The OpenID Connect provider can sign a valid token for the pinned subject, and an attacker who controls the person's account there can sign in with it; device approval is the control that still applies.
- **Shared relying-party IDs.** Where a spike result makes passkeys available on `ts.net`, a private address and a Funnel address of one machine share a relying-party ID; the per-address binding in the home, not the browser, keeps their passkeys apart.

- **A phone that is approved and unlocked.** On the Tailscale private address an approved device signs in with its key alone. A person who holds that device unlocked has the chats and can drive the agent within what was already granted: a workspace put on full access at the computer can still be driven from it, and a command there can do anything the person's user can, including writing the device records. The protections are the phone's own lock, removing the device at the computer and the remote session's idle limit of 12 hours.

<a id="decided-values"></a>
## Decided values

- The person registers Delo as a client at their own OpenID Connect provider during setup, entering the client ID and secret, with redirect URIs `https://<address>/auth/oidc/callback` for the `ts.net` and own-domain addresses; dynamic registration is used only when the provider advertises it and the person chooses it.
- Passkey relying-party IDs: the address's host on own domains; on `ts.net`, not available until a spike result adopts the host.
- Allowed ID token algorithms: `RS256`, `PS256`, `ES256` and `EdDSA`; passkey algorithms EdDSA, ES256 and RS256.
- Flows: 32-byte `state`, `nonce` and verifier, 10-minute lifetime, 20 pending per home; tickets 60 seconds.
- Key sets refreshed every 24 hours and on an unknown `kid` at most every 5 minutes.
