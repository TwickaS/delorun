---
description: "Contract C14: the identity factors a reach address can use, passkey relying-party IDs per address with the ts.net rule both ways, the person's own OpenID Connect provider with client registration and redirect URIs per address, required claims, audience per home, the owner identity pinned at its first enrolment, nonce, PKCE, issuer checks and mix-up protection, signing key IDs and rotation, and the Delorun issuer as a fast-follow."
---

# Contract C14: OpenID Connect and passkeys

English | [中文](c14-oidc-passkeys.zh.md)

<a id="summary"></a>
## Summary

Reach asks for an identity factor in addition to device approval: a passkey, or a sign-in at the person's own OpenID Connect provider. The home is the relying party for both. This page defines which factors each reach address can use, the passkey relying-party ID of each address, how the home registers as a client at the person's provider, the authorisation flow with its nonce, PKCE and issuer checks, the claims and audience the home requires, the owner identity it pins, how it fetches and rotates signing keys, and the rules that bind the Delorun issuer, a fast-follow. A factor never replaces device approval ([C5](c05-device-approval.md)). The types package [`@delorun/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.md) carries the rules, claims, codes and limits.

<a id="status"></a>
## Status

Face ID unlock (below) is built. The passkey and OpenID Connect sign-in factors on this page are not built: the home has no passkey relying party and no OpenID Connect client. The `tailnet-membership` factor of the Tailscale private route is built.

- **Built and reached:** setup's answers schema names `reach.identityFactor` and refuses any value other than `null` in a `--config` document ([C11](c11-setup-answers.md)).
- **Not built:** passkey enrolment and assertion with user verification and counters; client registration at the person's provider; the authorisation flow with `state`, `nonce`, PKCE and issuer checks; ID token checks and signing-key rotation; the pinned owner subject; re-authentication; the Delorun issuer.

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
  - [Authorisation flow](#authorization-flow)
  - [ID token checks](#id-token-checks)
  - [Owner subject](#owner-subject)
  - [Re-authentication](#re-authentication)
  - [Signing keys](#signing-keys)
  - [Tailnet identity](#tailnet-identity)
  - [Tailnet membership](#tailnet-membership)
  - [What a device may call](#what-a-device-may-call)
  - [Elevation](#elevation)
  - [PIN mode](#pin-mode)
  - [Limits](#limits)
  - [Errors](#errors)
  - [Delorun issuer](#delorun-issuer)
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

- **Registration options.** `POST /auth/passkey/register/options` returns `rp` `{ id: <relying-party ID>, name: "Delorun" }`; `user` `{ id: <the home's owner handle>, name: "owner", displayName: <device label> }`, where the owner handle is 32 random bytes fixed per home; `pubKeyCredParams` EdDSA (-8), ES256 (-7) and RS256 (-257); `authenticatorSelection` `{ residentKey: "required", userVerification: "required" }`; `attestation: "none"`; `excludeCredentials` listing this address's credentials; a 32-byte challenge; and a timeout of 300,000 milliseconds.
- **Storage.** `~/.delorun/secrets/home-auth/passkeys.json` holds, per credential, the credential id, the COSE public key and algorithm, the address, the relying-party ID, the signature counter, the transports, the creation time and the enrolling device id.
- **Assertion options.** `POST /auth/passkey/options` returns a 32-byte challenge, the relying-party ID of the listener's address, `allowCredentials` listing that address's credentials and `userVerification: "required"`.
- **Assertion checks.** The home accepts an assertion only when `clientDataJSON.type` is `webauthn.get`; its challenge is one the home issued, unused and unexpired; its origin equals the listener's address exactly; `rpIdHash` equals the SHA-256 hash of that address's relying-party ID; the user-present and user-verified flags are set; the credential is enrolled for that address; the signature verifies with the stored key; and a non-zero stored counter is less than the presented counter, which the home then stores.
- **Challenges.** A passkey challenge expires after 5 minutes and is single-use.

<a id="client-registration"></a>
### Client registration

During setup, or when the person turns reach on, the person registers Delorun as a client at their own OpenID Connect provider and enters three values: the issuer URL, the client ID and the client secret. Setup lists the redirect URIs to register, one `https://<address>/auth/oidc/callback` for each `ts.net` and own-domain address of the home.

- **Discovery.** The home reads `<issuer>/.well-known/openid-configuration` over `https`. The document's `issuer` must equal the entered issuer exactly, `response_types_supported` must include `code`, `code_challenge_methods_supported` must include `S256`, and `id_token_signing_alg_values_supported` must include an algorithm of [ID token checks](#id-token-checks); otherwise setup refuses with the matching code.
- **Dynamic registration.** Only when the provider's metadata has a `registration_endpoint` and the person chooses it, the home registers itself as RFC 7591 describes: `client_name` `Delorun`, the redirect URIs above, `grant_types` `["authorization_code"]`, `response_types` `["code"]`, `token_endpoint_auth_method` `client_secret_basic` and `application_type` `web`, with an initial access token when the provider requires one and the person enters it.
- **Storage.** `~/.delorun/secrets/home-auth/oidc-client.json` holds the issuer, client ID, client secret, redirect URIs and, after dynamic registration, the registration access token. No configuration row holds them.
- **One client per home.** A home's client registration is its own: two homes never share a client ID, so the client ID is the audience that names the home.
- **Adding an address.** Adding an address adds its redirect URI at the provider: the person adds it, or the home updates a dynamic registration through its registration access token.

<a id="authorization-flow"></a>
### Authorisation flow

1. **Start.** `GET /auth/oidc/start` with `purpose` (`enrol`, `sign-in`, `recovery` or `reauth`) and the device id creates a flow bound to the listener's address: a 32-byte `state`, a 32-byte `nonce`, a 32-byte PKCE `code_verifier`, the issuer, the purpose, the device id and the creation time. The home holds the flow in memory, sets the cookie `__Host-delorun-oidc` to a 32-byte random value whose hash the flow records, and redirects to the issuer's `authorization_endpoint` with `response_type=code`, `client_id`, the address's `redirect_uri`, `scope=openid`, `state`, `nonce`, `code_challenge` (the SHA-256 hash of the verifier) and `code_challenge_method=S256`. For `reauth`, it adds `prompt=login` and `max_age=0`, and `nonce` is the approval hash the device sends.
2. **Callback.** `GET /auth/oidc/callback` is accepted only when `state` names a pending, unexpired flow of this address and the `__Host-delorun-oidc` cookie matches the flow. When the provider's metadata sets `authorization_response_iss_parameter_supported`, the response must carry `iss` equal to the flow's issuer (RFC 9207); an `iss` that is present must equal it in every case. The flow is consumed at the callback, whatever its result.
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

The owner's identity at the person's provider is pinned when the owner claims the identity factor: the first OpenID Connect enrolment, made by a device of the owner ([C5](c05-device-approval.md#owner-claim)), records the issuer and `sub` in `~/.delorun/secrets/home-auth/owner.json`. Every later sign-in, recovery and re-authentication must present that pair, and so must an `enrol` flow for another address. Changing it is a sign-in factor change, accepted only from a trusted device in a live session after an `enrol` flow at the new identity; it rotates every session ([C4](c04-admission.md#rotation-and-revocation)). `delorun devices reset` removes the pin ([C5](c05-device-approval.md#reset)).

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

The home refuses a session whose factor is `tailnet-membership` with `403 LOOPBACK_REQUIRED` for each action granted only at the home's own computer: granting full access, whether an escalation to `danger-full-access` (including `plugin_manager`'s) or a workspace's full-access consent; granting a prompt marked `workspace-management` (the main chat's workspace tools and its other asks, and instruction-layer writes); granting a prompt marked `external-agent` (the start of an external agent such as Claude Code or Codex) and allowing or revoking such an agent for a workspace; allowing, declining or revoking the start of a stdio MCP server, of which a device reads only the names of the waiting servers and what changed in each; opening the approval window and approving or removing a device; reset; the recovery kit; enrolling an identity factor; and changing reach settings. The home refuses where the action is granted, not the client: an approval prompt that grants full access carries `grants: "full-access"`, and the answer of a Peer admitted with this factor is not applied, so the prompt stays open for the studio on the home's own computer. The remote studio says to approve the action at the computer. Watching, replying, starting chats, answering every other prompt and stopping a run are allowed, and installing a plugin from a phone needs an [unlock](#elevation) approved at the computer. The same rule holds for every Remote method the studio calls: the device's Peer speaks for its `reach-device` principal, whose remote access policy allows the methods and forwarded events of [what a device may call](#what-a-device-may-call), admits the elevated ones only under an unlock, and refuses every other with `remote-access/denied` and the reason `loopback-required: <action>`; the policy and its three tables live in [`@delorun/home-auth`](../../packages/home-auth/README.md).

<a id="what-a-device-may-call"></a>
### What a device may call

The owner's rule for a device is that an approved device is the person, and it can already prompt the agent: every action no riskier than a prompt is allowed, and an [unlock](#elevation) covers only the rare actions that widen what the agent can reach, add code that runs on the computer, or change the home's settings. `@delorun/home-auth` sorts every Remote method and every forwarded event of Delorun's default profile into one of four classes, and the reach access denial suite fails on an action no table names, on a table entry that names none, on an action two tables name, and on an action outside the class the [Elevation](#elevation) tables give its family.

- **Allowed**: the device does what the person does at the computer. The actions, with the reason for each, are `REACH_ALLOWED_ACTIONS` in [`reach-access.ts`](../../packages/home-auth/src/reach-access.ts).
- **Unlock**: refused with `403` and the reason `elevation-required: <action>` unless the device holds a [grant](#face-id-unlock) for that call, from Face ID or its PIN, or a live Face ID pass admits the call. The actions, with what each lets the person do, are `REACH_ELEVATED_ACTIONS` in the same file; an action is elevated only by being listed there. A `session/create` in a folder outside the known workspaces is elevated by the policy's condition, with the reason `CREATE_OUTSIDE_WORKSPACES`.
- **Never**: refused, unlocked or not, with `403 LOOPBACK_REQUIRED` and the reason `loopback-required: <action>`. The actions, with the reason for each, are `REACH_DENIED_ACTIONS` in the same file; no configuration changes the table.
- **A grant the computer alone gives**: refused wherever it is granted rather than where it is called ([tailnet membership](#tailnet-membership)).

Within the allowed actions, the policy's condition keeps two rules per call. A workspace-file call (`workspaceFiles/*`, `officeKit/render`) is admitted only when the real path of every path it names, the base file of a byte read included, lies inside the real path of the chat's workspace and outside the Delorun home; a path with a `..` segment or a leading `~`, and one that does not exist, is refused, unlocked or not. A `session/create` is allowed when it names a Workspace the Host lists, or a folder whose real path is a listed Workspace's path, with any preset; one that names another folder, or no Workspace and no folder (the Host's own working directory), needs an unlock. Choosing a preset grants no access by itself: a workspace's full-access consent is still the computer's answer, and every approval prompt still applies.

<a id="elevation"></a>
### Elevation

An elevation, an unlock in the studio's words ("sudo mode"), was a few minutes of elevated actions for one device, approved at the home's own computer. Once the home service has started, its grant store exists and an elevation admits no `face` action or prompt answer; the studio offers no unlock on a device, and only the computer lists requests. `@delorun/home-auth` keeps it in memory in [`elevation.ts`](../../packages/home-auth/src/elevation.ts), with the limits `ELEVATION_LIMITS` of `@delorun/contract-oidc-passkeys`.

The three tables below are the classes of [`AUTH_CLASSES`](#face-id-unlock) for Remote methods: the first is `free`, the second `face` (a grant for the call or a live Face ID pass, except the `alwaysAsk` rows, which always need a grant; a device with no passkey takes the one-action PIN grant, and the unlock below covers only the actions an unlock covered before) and the third `computer`.

**Allowed without an unlock**

| Family | Actions |
| --- | --- |
| Chats, read and write | `session/*` reads, `session/create` in a known workspace with any preset, `session/fork`, `session/prompt`, `session/updateQueue`, `session/cancel`, `session/rename`, `fileUploads/upload`, `userQuestions/*`, `subagents/*`, `job/*`, `toolResults/watch`, `sessionReferenceResolver/candidates`, `skills/list`, `commands/list` |
| Chat and workspace organisation | `workspace/follow`, `workspace/pinSession`, `workspace/unpinSession`, `workspace/archiveSession`, `workspace/unarchiveSession`, `workspace/insertSessionBefore`, `workspace/insertBefore`, `workspace/rename`, `workspace/delete` (to the trash), `workspace/initializeDefault` |
| Goals and scheduled follow-ups | `goals/*`, `schedule/*` |
| Models and presets | `session/selectModel`, `session/initializeDefaultModel`, `session/modelCatalog`, `llm/listProviders`, `llm/listConfigurableProviders`, `llm/discoverModels`, `agentPresets/*`, `permissionPresets/catalog` |
| Files of a chat's workspace | `workspaceFiles/list`, `read`, `readBytes`, `stat`, `changes`, `officeKit/*`, `fileReferences/list`, by the workspace-file rule |
| Reads of settings and plugins | `settings/describe` (secrets redacted), `pluginManager/history`, `inspect`, `listBundles`, `listPlugins`, `listVersionExemptions`, `listVersions`, `readBundleDetail`, `registries`, `waitForInstall`, `pluginInventory/list`, `pluginRegistryProbe/fastest` |
| Feedback | `sessionFeedback/record`, `messageFeedback/*` |
| Forwarded events | `event:approval/request` (the answer guard still refuses a grant), `event:user-questions/request`, `event:api-session/*`, `event:agent-preset/selected`, `event:commands/change`, `event:goal/activation-changed`, `event:llm/*`, `event:permission-presets/catalog-changed`, `event:plugin-manager/*`, `event:plugin-market/changed`, `event:settings/document-updated`, `event:schedule/changed` |

**Unlock**

| Family | Actions | Why |
| --- | --- | --- |
| Settings writes | `settings/mutate`, `settings/replace`, `settings/update` | They change the home's settings. The condition refuses a write that could turn a computer-only switch off, with `loopback-required: turning <switch> off`, under an unlock as well: a plugin registers such a switch with `HomeAuthService.registerComputerOnlySwitch` while it is mounted, and `@delorun/plugin-delegation-consent` registers its `enabled` field, so the refusal reads `loopback-required: turning the external-agent consent off`. The field may only be written as a literal `true`, a `replace` must name it so, and arguments the condition cannot read are refused. The condition also refuses a write of a permission-preset row's `defaultPreset` that would loosen the permission new chats start in, with `loopback-required: loosening the permission new chats start in`, under an unlock as well: a preset whose sandbox mode or approval policy is looser than the current one's, a preset the rows do not hold, a write that removes the field, or any change while the current preset cannot be read; a stricter or equal preset is an ordinary write. The only protected plugin row that is a settings namespace is the external-agent consent's, whose switch the condition decides; the bash sandbox's live fields are execution limits, and the sandbox mode belongs to the sandbox-policy row, which has none. |
| Slash commands | `commands/execute` of a command `REACH_DEVICE_COMMANDS` lists: `compact`, `export`, `goal`, `permission` and `plan` | Each changes only its own chat or reads it. The condition parses the line with the commands service's own parser and refuses any other command, or a line that names none, with `loopback-required: commands/execute of a command a device does not run`, under an unlock as well, so a command a plugin adds is refused until it is listed. |
| Plugins and profile history | `pluginManager/installBundle`, `updateBundle`, `removeBundle`, `setBundleEnabled`, `setPluginEnabled`, `setVersionExemption`, `cancelInstall`, `undo`, `restore` | They add or enable code that runs in the Host outside any sandbox. A protected row, one whose module the `plugin-manager` row's `protectedPlugins` names (the consent and guard rows, the update gate and update check, home-auth, reach and the sandbox rows), is never changed from a device: the condition refuses `setPluginEnabled` on one, or with arguments it cannot read, with `loopback-required: changing a protected plugin row`, under an unlock as well, and every row while the list cannot be read. The plugin manager refuses every other change that would disable, remove or reconfigure a protected row, or restore a profile state in which one differs, with `management-required`, unlocked or not. |
| Terminals | `terminal/*` | A terminal is a shell on the computer outside the sandbox. Opening one needs a [Face ID grant](#face-id-unlock) for that call, always: no switch, full-access grant or dangerous mode waives it, and the approval grace is not an unlock. |
| External tool servers | `mcpManager/probe`, `restart`, `watch` | They start and observe the commands the home configured for its external tool servers. |
| Folders | `directoryPicker/*`, `workspace/create`, `session/create` in a folder outside the known workspaces | A folder decides where a chat's commands may write. |
| Dynamic plugin code | `dynamicCordisRunner/*`, `event:cordis/*` | It runs model-authored plugin code in the Host. |

**Never**

| Family | Actions | Why |
| --- | --- | --- |
| Account | `account/*`, `event:deepseek-account/*` | Account sign-in is off in Delorun, and an account change belongs to the computer. |
| The computer's own screen | `settings/openSettingsDocument`, `session/openWorkspacePath`, `session/workspacePathApplications` | They open an application on the computer, which a device has no use for. |
| Grants and devices | a full-access escalation, a workspace's full-access consent, a `workspace-management` prompt, device approval and the removal of another device by a device that holds no passkey, starting, approving or extending an unlock | The computer's routes and the answer guard refuse each ([tailnet membership](#tailnet-membership)); none is a Remote method a table could list. |

- **Routes.** A device reads its state at `GET /auth/elevation` (`none` and `pending` carry `unlockMinutes`, the minutes an unlock on its listener lasts, so the studio states the length before an unlock), asks at `POST /auth/elevation/request` and locks at `POST /auth/elevation/lock`, each with a live session of the reach listener it arrived on and a `POST` only from the studio's own origin. The computer lists at `GET /auth/elevation/pending`, approves at `POST /auth/elevation/approve` and revokes at `POST /auth/elevation/revoke`; a device reaching these is refused with `LOOPBACK_REQUIRED`.
- **Loosened settings.** While dangerous mode holds, a device with a grant for the call may loosen the default preset and turn off a switch `DANGEROUS_LIFTABLE_SWITCHES` lists. The policy records each such write, with the field's previous value and the value the call sets, in `~/.delorun/secrets/home-auth/reach-dangerous-settings.json` before the call proceeds. When the mode no longer holds (at the first read that finds it ended, and at start) the home writes the previous value back through the settings service, unless the field no longer holds the recorded device value because the person changed it at the computer. A failed write keeps its record and is retried.
- **Terminals.** Every `terminal/*` action needs its confirmation, always, on every Session and on the global resource, except `terminal/environment`, `terminal/shells` and `terminal/list`, which read a terminal's size limits, the chat's working directory, the shells it can start and the chat's terminals (each one's id, title, shell, starting working directory, size, state, exit code, a fixed line in place of any launch error text, who started it, who holds its input and its sandbox mode), and no output or input (the grant for `terminal/create`, or for `terminal/retain` or `terminal/attach` of an existing terminal, also opens the [hold](#face-id-unlock) for that terminal, so a reloaded terminal tab confirms once the hold has lapsed and rides it before then; a phone never asks for `terminal/retain` itself, which the studio sends for every saved tab, and the terminal on screen asks through `terminal/attach`): dangerous mode, a workspace's full-access grant and the folders a terminal would open in decide nothing. An earlier version kept a terminal switch in `~/.delorun/secrets/home-auth/reach-terminal.json`; nothing reads that file now, a home that still has it keeps working, and the file can be deleted. A terminal already open keeps running until it ends.
- **Request.** A signed-in device asks from its own studio. The home records the request against the device, the listener and the session it arrived on, and the device shows an 8-digit code. A request waits 5 minutes, a home holds 5, and a new request from the same device on the same listener replaces its waiting one. While the device holds an unlock its state shows the unlock, not a code, so a device cannot extend its own unlock.
- **Approval.** Only the person at the home's computer approves, by typing the device's code in `delorun devices elevate`, which calls [C19](c19-home-process.md)'s `devices.elevate`, in the studio's Settings, Devices, or through the computer routes; the third wrong code cancels the request. Approving and revoking are `elevation-approve` and `elevation-revoke` of `LOOPBACK_REQUIRED_ACTIONS`, which a device is refused.
- **Length.** An unlock lasts the reach row's `elevationMinutes`, 15 by default and 60 at most; a larger value is refused when the listener is served. Nothing extends an unlock: a new approval replaces it.
- **Scope.** An unlock is bound to its device, its listener and its profile. The `reach-device` principal names the device and the listener its Peer sits on, and the policy asks for the device's unlock on that listener alone. One profile's Host keeps its own unlocks in memory, never in the shared secrets directory, so another profile's Host sees none, and a restart ends them.
- **Check.** The condition of the device's bindings reads the unlock before each elevated action, for a call and for an event, a snapshot or a list filter alike, and refuses one past its end even before its timer fires. Each call an unlock admits is logged with the device, the listener, the action and the unlock's id. The Gateway decides a stream only when it opens, so when an unlock ends the home closes the device's reach connections, and the studio reconnects without it.
- **End.** An unlock ends at its end, when the person revokes it at the computer, when the device locks it, when a new approval replaces it, when the session that asked ends (its limits or a rotation; a roll continues it), when the device is removed, when the listener stops and when the Host stops. Each start and ending is logged with the device, the listener, the unlock's id and the reason, `ELEVATION_END_REASONS`.

<a id="face-id-unlock"></a>
### Face ID unlock

A paired device may confirm a sensitive action with a passkey (Face ID, Touch ID, Windows Hello or the device lock) or with its PIN, one action at a time, or open a pass with one Face ID. It is an unlock factor, not an identity factor: the device key and the reach session stay the sign-in, and the sign-in factors above are unchanged.


**One table.** `AUTH_CLASSES` in `auth-classes.ts` puts every Remote method, plugin Fetch route, prompt answer and `/auth` route in exactly one of four classes: `free` (any approved device, no prompt), `face` (one confirmation at the moment of the action, or a live Face ID pass, unless the row is marked `alwaysAsk`), `computer` (only the person at the computer) or `ticket` (a device route that works only with the single-use enrolment ticket the computer's approval minted, such as `register/options`, `register` and `add/request`). Every action a phone could take only at the computer under the former Careful level is `face` or `computer`, so a PIN-only device can do nothing it could not before. The spec `tests/auth-classes.spec.ts` fails on an unlisted action or route, a duplicate row and a row in two classes.

**Enrolment.** A passkey is created with `residentKey: required`, `userVerification: required`, `attestation: none`, a platform authenticator and the address host as relying-party ID. The home mints a single-use enrolment ticket, bound to the device, listener and session, when the person approves the pairing at the computer; a paired device without a passkey asks with `POST /auth/passkey/add/request`, shows the 8-digit code the home derives under the label `delorun-passkey-v1` (each input length-prefixed), and the person types it at the computer. `POST /auth/passkey/register/options` and `/register` are refused without a live ticket. Synced passkeys are allowed: the binding is the device's session, not the authenticator, so an assertion counts only on a live session of the device that owns the credential, on its listener.

**Per-action assertion.** `POST /auth/passkey/options` takes the actions to confirm (name and a hash each) or one prompt answer, and returns a 32-byte challenge the home keeps for 60 seconds with the device, session, listener and what was asked; `allowCredentials` lists only that device's credentials. `POST /auth/passkey/verify` applies the assertion checks above (user presence and verification, origin, relying-party hash, signature, counter) and that the credential belongs to the session's device. A passing assertion mints a grant and also opens a Face ID pass and answers `pass: { startedAt, endsAt }` when the setting is above 0 and the action is not an always-ask one; a failed assertion counts as a wrong try in the PIN's counters (the fifth removes the device, ten across the home pause both factors), while an expired, used or unknown challenge is refused and counts for nothing, as does a sheet the person cancels. `POST /auth/passkey/pin` mints the same grant from a correct PIN, for a device with or without a passkey, except that it never mints `auth/devices/remove` or another device's `auth/passkey/remove`: removing another device, or another device's passkey, needs a grant from a device that holds a passkey itself. A correct PIN never opens a pass.

**Grants.** The home keeps grants in memory, keyed by device, listener, action and the SHA-256 of the call as the home received it: for a Remote call the JCS (RFC 8785) text of its arguments; for a Fetch route its method, path and body, read by the home up to 1 MiB. A grant lives 30 seconds and is used once, only after the whole decision allows; a question without arguments never uses one. A Fetch call names its grant in the `Delorun-Grant` header, which the home removes before the route runs; the hash it checks is never the client's. A prompt answer is keyed by device, listener, the agent, the call id, the grants marker of the prompt (`full-access`, `workspace-management`, `external-agent` or `real-browser`) and the answer value, so a grant for "Allow once" never admits a persistent allow and one call that raises two prompts needs two grants; a prompt with no call id cannot be answered by a device with a grant.

**Holds.** A grant that creates or attaches to a terminal, or opens a folder picker, also opens a hold bound to that terminal's or picker's id and to the device on its listener, with a 5-minute idle cap and a 60-minute absolute cap; a hold admits that id's follow-up calls, never output or events of another terminal. Every page and tab of the device shares the hold, so a reload or a second tab showing the same terminal asks nothing while the hold lasts. Another id needs a new grant (or a live pass).

**Every device** is admitted to a `face` action, and to a granting answer of a prompt marked `full-access`, `workspace-management`, `external-agent` or `real-browser`, by a grant, or by a Face ID pass of a device that holds a passkey: a PIN page unlock, a code typed at the computer, the approval grace and dangerous mode admit nothing in the class, and `POST /auth/pin/unlock` is refused to every device with `ELEVATION_REQUIRED`. A device without a passkey mints its one-action grants with its PIN, one per action, so it reaches exactly what a device with a passkey reaches; only a passkey device can avoid the one confirmation per action.

**The pass.** One Face ID (a passkey assertion with user verification) on a paired device opens a pass for that device when the pass setting is above 0. While the pass is live, the device's `face` actions (installs, terminal, settings writes, model keys, Changes and updates, approval answers that grant something other than full access, and so on) are admitted with no per-call grant, so no Face ID sheet appears. The pass is bound to the device and the listener (`GrantStore.openPass` keys it on those two alone; a device holds no page unlock, and a call that carries one matches no pass), is fixed from the moment of the Face ID, does not slide with use and lives in memory only.

**Setting.** Settings → Face ID → "Ask again after": Every time, 5, 15, 30 or 60 minutes. "Every time" (0) means one Face ID per action. The person's choice is stored in `face-id-pass.json` in the home-auth secrets directory. Until they choose, the deployment default applies: the `faceIdPassMinutes` field of the home-auth plugin's config, one of 0, 5, 15, 30 or 60, 15 by default; a value outside the set fails the load. A change ends every live pass, so a shorter length or Every time takes effect at once.

**Always asks.** Every `face` row of `AUTH_CLASSES` declares what a pass does for it in `src/pass-policy.ts`, `admits` or `alwaysAsk`, and the table check fails on a `face` row that declares neither. A row marked `alwaysAsk` is never admitted by a pass and needs a one-action grant for that call during a pass too: removing another device (`auth:/auth/devices/remove`, Face ID only, never the PIN), removing a passkey (`auth:/auth/passkey/remove`), listing every device's passkeys in the Face ID settings (`auth:/auth/passkey/devices`) changing the pass setting from a device (`auth:/auth/passkey/pass (write)`, which needs a grant a passkey minted, never the PIN), turning Changes protection off (`changes:protection-off`), a workspace's full access (`plugin-permission-defaults` `setFullAccess`) and an approval answer that grants full access (`answer:full-access`, action `answer/full-access`). A Face ID on such an answer still opens a pass, since only an always-ask action entry stops one. A Face ID that confirms an always-ask action opens no pass. Reach settings and PIN mode settings stay computer-only, and every `computer` row stays computer-only.

**What never opens a pass.** The PIN (`POST /auth/passkey/pin`), on a phone with no passkey or as the fallback on a passkey phone; a code from the computer; the approval grace after pairing; dangerous mode.

**What ends it.** Its end time; 5 minutes with no request from the device on that listener (an admitted HTTP request or a Remote call counts as one; an idle end never extends the pass); Lock now (`POST /auth/passkey/lock`), which ends the device's pass on every tab, so one tab hidden that long locks the others too; the studio page hidden for 5 minutes, which the client checks by a timer and again when the page comes back, because a phone suspends a hidden page and its timers, and then calls Lock now before anything else; a change of the pass setting, from a device or at the computer, which ends every live pass; the Peer's disposal; the end of the device's session or its sign-out; the device's removal; a rotation of every session; a restart.

**Terminals.** Terminal holds are unchanged: under a pass `terminal/create` is admitted with no sheet and opens the terminal's hold, so the terminal stays open under the hold's limits (5 minutes unused, 60 minutes in total) after the pass ends.

**Routes.** `GET /auth/passkey/pass` answers `{ minutes, choices: [0, 5, 15, 30, 60], pass: { startedAt, endsAt, remainingMs } | null }`, with `pass` null at the computer; the studio counts down from `remainingMs`, the home's clock, so a phone's skewed clock does not move the end. `POST /auth/passkey/pass` with `{ minutes }` changes the setting: at the computer like any setting there, from a device only with a passkey-minted grant for action `auth/passkey/pass` whose hash is the SHA-256 of the JCS text of the body; a value outside the set is `400 BAD_REQUEST`. `POST /auth/passkey/verify` also answers `pass: { startedAt, endsAt, remainingMs }` when one is live. A Changes, Update or seat call the studio sent under a pass that the home refuses (the pass ended in between) is asked again with the sheet, and before it skips a sheet the studio reads the pass from the home once more. `POST /auth/passkey/lock` with `{}` answers `{ ended }`; it is a `free` route.

**In the studio.** On a device page with a live pass, the chip "Unlocked · N min" with a Lock now button shows above the open chat (the `conversation.session.banner` slot), counting down in whole minutes and disappearing at the end. The computer never shows it.

**`unlockModeEnabled`.** A locked device is refused where an unlock matters when a PIN is set or any passkey is enrolled; this one reading replaces the former PIN-only check in the key actions, the key-device gate and the page-unlock token check, so a home with a passkey and no PIN refuses a key change without a grant.

**Management.** A device lists every device's passkeys at `GET /auth/passkey/devices` and removes one at `POST /auth/passkey/remove`, each a `face` action marked `alwaysAsk`, so a pass never admits it; removing another device, at `POST /auth/devices/remove`, is the same. Removing a device removes its passkeys, grants and holds in the same call. A passkey enrolled on another address cannot assert on this one and the device sets Face ID up again.

**Logs.** `passkey.enrolled`, `passkey.removed` and `passkey.backup-state-changed` name the device and never a challenge, key or signature. The home logs `home-auth: pass.started device=… listener=… minutes=…` and `home-auth: pass.ended device=… listener=… reason=<expired|lock-now|peer-ended|session-ended|device-removed|sessions-rotated>`; an expired pass is logged when the home next looks at it. A granting answer a pass admitted logs `home-auth: pass.used device=… listener=… answer=… grants=…`. The pass is not model-visible, so it has no session event.

<a id="pin-mode"></a>
### PIN mode

PIN mode lets a person who holds an approved device confirm one action at a time with a PIN or passcode: a correct PIN at `POST /auth/passkey/pin` mints a one-action grant, as Face ID does, and the PIN is the fallback factor of a device that holds a passkey. No device holds a page unlock: `POST /auth/pin/unlock` is refused to every device with `ELEVATION_REQUIRED` and reads nothing of the request, so the PIN opens no window and no pass, and nothing else about sign-in changes: the device key and the reach session stay as they are. Version 1 of the mode is built for the Tailscale private address only; the passkey unlock, the Funnel and relay addresses, and the setting of the PIN, the turning on of the mode and the pairing of devices from a device are not built, and each stays at the computer.

- **State.** `~/.delorun/secrets/home-auth/pin-mode.json` holds `enabled`, the secret's `kind`, a salted `scrypt` hash with its parameters, the idle minutes and the lock-when-hidden choice. `pin-attempts.json` holds the wrong tries per device and across the home, and a restart keeps them. `reach-pin-settings.json` (0600) holds the settings a page unlock of an earlier build loosened, with each field's previous value, as `reach-dangerous-settings.json` does for dangerous mode; no page records one now, and turning the mode off sets each back unless the person changed it since. A record whose settings row is not described yet stays; the set-back runs at start and when the settings service mounts. A failed write logs one warning per field (the namespace and field, never a value) and is retried on a timer of `pinSetBackRetrySeconds` (1 to 3600, 30 by default) that runs only while a lift waits after the mode is off; a read of the mode starts no pass. `GET /auth/pin/mode` lists the fields still waiting as `setBackWaiting`, and `delorun devices pin status` names them. A page's settings write is refused where dangerous mode would not lift it, whatever the page holds. The settings document and `account/*` stay refused to every page. A home without the file, or with `enabled: false`, is exactly the home this page describes everywhere else: the PIN grant answers `PIN_MODE_OFF` and no grant follows from a PIN.
- **The secret.** A PIN is 6 to 128 digits that is not a repeat (`111111`, `123123`), a run (`345678`) or a common PIN. Any other secret is a passcode of 10 to 128 characters that is not one character repeated. Both are normalised to NFC. The home compares in constant time and never writes the secret to a log, an error or a file in the clear. The limits are `PIN_MODE_LIMITS` of `@delorun/contract-oidc-passkeys`.
- **Setting it.** Only the person at the computer sets, replaces or clears the PIN and turns the mode on or off: `POST /auth/pin/set`, `/auth/pin/options`, `/auth/pin/off` and `/auth/pin/resume` answer a request that arrived on the loopback listener with the studio's credential and refuse a device with `LOOPBACK_REQUIRED`; the `pin.set`, `pin.options`, `pin.off` and `pin.resume` requests of [C19](c19-home-process.md) do the same for `delorun`. `pin-mode-change` is in `LOOPBACK_REQUIRED_ACTIONS`. `POST /auth/pin/options` takes `idleMinutes` (a whole number from 1 to 60) and `lockWhenHidden` and changes only those two on the record the mode already holds, with no PIN or passcode: the computer is already trusted for the setting. It leaves the hash and the kind alone, is refused with `PIN_MODE_OFF` while the mode is off and with `BAD_REQUEST` for an empty change, another field or a value out of range, and is written with the same protected write as every other change.
- **No unlock.** `POST /auth/pin/unlock` answers a device `403 ELEVATION_REQUIRED` after the device-route checks (live session, studio origin) and before reading the body: it mints no token, no unlock and no elevation, and counts no try. `GET /auth/pin/state` reports the mode (`lockWhenHidden` among its fields) and never an unlock. A `Delorun-Unlock` header or `delorun-unlock.<token>` subprotocol names no running unlock, so it admits nothing; `POST /auth/pin/touch` and `POST /auth/pin/lock` answer `401 UNLOCK_INVALID`.
- **Wrong tries.** A try is counted and written before the secret is compared, one at a time per device. The fifth wrong try of a device removes the device exactly as a removal at the computer does, so its sessions and connections close and it needs approval again at the computer. Ten wrong tries across the home within 24 hours pause the PIN and Face ID, answering `PIN_UNLOCKS_PAUSED`, until the person resumes them at the computer. A correct secret clears the device's count.
- **Logs.** Each wrong try, lockout, pause, resume, PIN change and mode change is a log line that names the device and never the secret.

The error codes `PIN_INVALID`, `PIN_WEAK`, `PIN_MODE_OFF`, `PIN_NOT_ALLOWED_ON_ADDRESS`, `PIN_UNLOCKS_PAUSED` and `UNLOCK_INVALID` join [the errors below](#errors). A `PIN_INVALID` answer carries the structured fields `triesLeft` (a number) and `removed` (a boolean, true for the fifth miss, which removed the device), and a `PIN_UNLOCKS_PAUSED` answer carries `paused: true`, beside `error` and `message`, so a client never reads the sentence. `GET /auth/pin/state` carries `lockWhenHidden` for a page that is on.

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
| `OIDC_STATE_INVALID` | An unknown, used or expired `state`, or a missing or different `__Host-delorun-oidc` cookie. |
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
| `PIN_INVALID` | A PIN or passcode that is not right; the fifth of a device also removes the device. The body also carries `triesLeft` (a number) and `removed` (a boolean, true for the fifth), so a page never reads the sentence. |
| `PIN_WEAK` | A new PIN or passcode that breaks the rules of [PIN mode](#pin-mode). |
| `PIN_MODE_OFF` | A PIN grant while the mode is off. |
| `PIN_NOT_ALLOWED_ON_ADDRESS` | A PIN grant on a reach listener other than the Tailscale private one. |
| `PIN_UNLOCKS_PAUSED` | A PIN or Face ID try after ten wrong tries across the home in 24 hours, until the person resumes them at the computer. The body also carries `paused: true`. |
| `UNLOCK_INVALID` | A page-unlock token; no device holds a running page unlock, so every token is unknown. |
| `LOOPBACK_REQUIRED` | A session whose factor is `tailnet-membership` answers a prompt or sends a request for an action granted only at the home's own computer ([tailnet membership](#tailnet-membership)). |

<a id="delorun-issuer"></a>
### Delorun issuer

The Delorun issuer, which lets a person sign in with a Delorun account, is not part of Delorun, which configures no Delorun issuer ([roadmap](../guide/roadmap.md)). Such an issuer follows every rule of this page as a second issuer, and also these:

- Its redirect URI is `https://<address>/auth/oidc/callback/delorun`, so it never shares a redirect URI with the person's provider.
- It signs ID tokens with asymmetric keys only, every token header carries `kid`, and it publishes a key set.
- It publishes a new signing key in its key set at least 24 hours before it signs with it, and keeps a retired key there for at least 24 hours after its last use.
- Its signing private keys are Cloudflare Worker secrets, never in a repository, a configuration file or a log.
- Its audience is the client ID the hosted service assigns to each home.

<a id="consumers"></a>
## Consumers

- `delorun/packages/home-auth/src/identity/`: the passkey relying party, the OpenID Connect relying party, enrolment and the `tailnet` factor.
- `delorun/packages/home-auth/`: sign-in tickets in session creation, approvals' re-authentication and the owner record.
- Setup in `delorun/apps/cli/`: client registration, dynamic registration and the redirect URI list.
- `delorun/packages/plugin-reach-ui/`: enrolment screens and the statement that passkeys are not available on an address.
- `delorun/packages/contract-oidc-passkeys/`: the rules, claims, codes and limits.
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
| `a replayed state or foreign browser is refused` | A callback reusing a consumed `state`, or arriving without the flow's `__Host-delorun-oidc` cookie, is refused with `OIDC_STATE_INVALID`. |
| `a wrong nonce or verifier fails` | A token whose `nonce` differs is refused, and a token request with another `code_verifier` gets no token from the stand-in. |
| `another subject is refused` | A valid token for a `sub` other than the pinned one creates no sign-in ticket. |
| `a passkey assertion for another address's relying-party ID is refused` | An assertion made for one address's relying-party ID, presented on another address, is refused with `PASSKEY_ASSERTION_INVALID`. |
| `a passkey without user verification is refused` | An assertion without the user-verified flag is refused. |
| `a regressed counter is refused` | An assertion whose counter is not greater than a non-zero stored counter is refused. |
| `a passkey on a ts.net address is refused under the current contract` | Passkey registration and assertion options on a `ts.net` address answer `PASSKEY_UNAVAILABLE`. |
| `tailnet-membership is refused on a Funnel or own-domain address` | A provider that declares `tailnet-membership` for the Funnel listener or an own-domain address is refused with `TAILNET_IDENTITY_UNAVAILABLE`. |
| `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent` | An `allowed-once` answer from a `tailnet-membership` session to a prompt that grants full access is refused with `LOOPBACK_REQUIRED`; the escalated call does not run and the workspace records no consent, and the same prompt answered on the loopback studio grants. |
| `a tailnet-route session cannot start an external agent` | An `allowed-once` answer from a `tailnet-membership` session to a prompt marked `external-agent` is refused with `LOOPBACK_REQUIRED`, so the agent does not start; declining it from the session applies, and the same prompt answered on the loopback studio is applied. |
| `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach` | Each such request from a `tailnet-membership` session is refused, and the home's devices and reach state are unchanged. |
| `five wrong PINs remove the device and close its sessions` | The fifth wrong PIN of a device removes it as a removal at the computer does, closes its sessions, and a restart keeps the count; twenty parallel guesses spend at most five. |
| `ten wrong PINs across the home pause the PIN` | Ten wrong tries by several devices within 24 hours answer `PIN_UNLOCKS_PAUSED` to a correct PIN until the computer resumes. |
| `the PIN routes refuse a Funnel listener, the loopback listener and a device that sets the PIN` | `PIN_NOT_ALLOWED_ON_ADDRESS`, a non-device refusal and `LOOPBACK_REQUIRED`. |
| `the PIN unlock is refused to every device` | `POST /auth/pin/unlock` answers `ELEVATION_REQUIRED` with the right PIN, a wrong one or no body, mints no token or elevation and counts no try; a forged `Delorun-Unlock` token admits nothing. |
| `a page that holds an old unlock gets no face action, answer or lift` | A no-passkey device's page with a running page unlock is refused every `face` action, every reserved granting answer and every dangerous-mode lift without a grant; its PIN grant admits one action once. |
| `with PIN mode off nothing changes` | The PIN grant answers `PIN_MODE_OFF`, no elevation exists, and the elevated actions are refused as before. |
| `the PIN is in no log, error or file in the clear` | The PIN text is absent from the log lines, the response bodies and the files. |
| `a stale re-authentication is refused` | A `reauth` token with `auth_time` older than 120 seconds, or with a `nonce` other than the approval hash, does not approve. |
| `a device chooses the preset a chat that has not started runs with` | `agentPresets/select` from a `reach-device` Peer returns the chosen preset and the chat records `agent-preset/selected`; a preset that names full access still meets the workspace's consent refusal, which is granted only at the computer. |
| `a device reads the files of its chat's workspace and no path outside it` | `workspaceFiles/list`, `read`, `readBytes` and `stat` succeed for a path whose real path lies inside the Session's workspace and are refused with `loopback-required: <action> with a path outside the chat's workspace` for a path outside it, one through a symbolic link that leads outside it, one into the Delorun home and one that does not exist; `workspaceFiles/changes` stays refused. |
| `a device reads the installed plugins and cannot change them` | `pluginManager/listPlugins`, `listBundles`, `registries`, `history` and `pluginInventory/list` succeed, and `installBundle`, `setPluginEnabled`, `setBundleEnabled`, `removeBundle` and `undo` are refused with `loopback-required: <action>`. |

<a id="what-this-does-not-prove"></a>
### What this does not prove

- **User verification under `attestation: "none"`.** The home reads the user-verified flag the authenticator sets and does not verify the authenticator, so the flag is only as trustworthy as the authenticator that made the assertion.
- **The person's provider.** The OpenID Connect provider can sign a valid token for the pinned subject, and an attacker who controls the person's account there can sign in with it; device approval is the control that still applies.
- **Shared relying-party IDs.** Where a spike result makes passkeys available on `ts.net`, a private address and a Funnel address of one machine share a relying-party ID; the per-address binding in the home, not the browser, keeps their passkeys apart.

- **A phone that is approved and unlocked.** On the Tailscale private address an approved device signs in with its key alone. A person who holds that device unlocked has the chats and can drive the agent within what was already granted: a workspace put on full access at the computer can still be driven from it, and a command there can do anything the person's user can, including writing the device records. Such a device also has a terminal and the Changes controls, each use with a confirmation for that one call (a Face ID grant, or the PIN as a one-action grant) or within a Face ID pass the device opened. The protections are the phone's own lock, removing the device at the computer and the remote session's idle limit of 12 hours.

<a id="decided-values"></a>
## Decided values

- The person registers Delorun as a client at their own OpenID Connect provider during setup, entering the client ID and secret, with redirect URIs `https://<address>/auth/oidc/callback` for the `ts.net` and own-domain addresses; dynamic registration is used only when the provider advertises it and the person chooses it.
- Passkey relying-party IDs: the address's host on own domains; on `ts.net`, not available until a spike result adopts the host.
- Allowed ID token algorithms: `RS256`, `PS256`, `ES256` and `EdDSA`; passkey algorithms EdDSA, ES256 and RS256.
- Flows: 32-byte `state`, `nonce` and verifier, 10-minute lifetime, 20 pending per home; tickets 60 seconds. The Face ID pass takes 0, 5, 15, 30 or 60 minutes, 15 by default, set by `faceIdPassMinutes` until the person chooses, and ends after the page is hidden 5 minutes.
- Key sets refreshed every 24 hours and on an unknown `kid` at most every 5 minutes.
