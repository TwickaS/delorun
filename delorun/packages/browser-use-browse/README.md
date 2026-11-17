---
description: "The person's own browser as a second browser in Delorun, through browse, for maintainers changing how a chat asks for it, how long the grant lasts, which runs may use it and what the browse server inherits."
kind: "package-bundle"
---

# @delorun/browser-use-browse

English | [中文](README.zh.md)

## Summary

`@delorun/browser-use-browse` lets the agent use the person's own browser, with their sign-ins, beside the isolated browser every chat already has. It runs [browse](https://github.com/anomalyco/browse) (`@opencode/browse`, MIT) as an MCP server through the session MCP mount of [`@deepseek-ai/dsh-experimental-browser-use-runtime`](../../../packages/experimental/browser-use-runtime), and only in a chat the person allowed. The agent asks with the `use_my_browser` tool; the person allows it on the approval card, once per chat. The grant lasts until they turn it off or the chat ends, restarts included. Runs the person did not start, such as scheduled ones, use it only while the chat also holds the "also when I'm away" permission.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Surfaces](#surfaces)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **The ask.** `use_my_browser` takes the task in one line and raises an approval card with the `real-browser` grant marker ([copy](src/copy.ts)). `@delorun/home-auth` accepts an answer from the home's own computer or from an approved device unlocked with a code or PIN; a device that is only signed in, or holds only the approval grace, is refused and the card stays open. Allow records `approval/decided` and then `real-browser/granted`, which names the `approval/asked` it answers. Any other answer records no grant, and the model is told to carry on with the isolated browser. A chat whose approval policy is `never` has the ask rejected without anyone being asked.
- **The grant.** The `realBrowserGrant` projection ([grant](src/grant.ts)) folds `real-browser/granted`, `real-browser/away` and `real-browser/ended` from the chat's own log, so a resumed chat keeps its grant and a forked one starts without its parent's. Turning it off appends `real-browser/ended`, which also ends the away permission.
- **Who may use it.** A browse call runs only in a turn the person's own prompt started (`user` or `retry`), or in any other turn while the away permission runs; every other call is refused with one sentence before the server sees it ([guard](src/tool.ts)). `use_my_browser` raises no card in a turn the person did not start. A run with no grant, such as a plain `delorun headless` task, keeps the isolated browser and is told so.
- **The away permission.** `real-browser/away` records when it ends, `awayDays` after it was given, with `cause: 'person'`; giving it again renews it, and turning it off records `until: null`. When a browse call in a run the person did not start is refused because it ran out, the lapse is recorded once, as `until: null` with `cause: 'expired'`.
- **The server.** browse starts only for a chat whose grant runs; `use_my_browser` answers once it has started, so its tools are there at the model's next step. It stops when the grant ends. The row takes no browser-use slot, so the isolated browser stays. The program is the pinned platform binary of `@opencode/browse` for this computer ([config](src/config.ts)). Its environment is the MCP client's scrubbed one, with every inherited `OPENCODE_BROWSER_*` variable blanked except those `inheritEnv` lists, and with `OPENCODE_BROWSER_AUTO_UPDATE=off` and `OPENCODE_BROWSER_UPDATE_CHECK=0` set. `inheritEnv` can never list the update switches, the escape hatches (`ALLOW_ALL_COOKIES`, `ALLOW_ALL_STORAGE`, `ALLOW_FILE_URLS`, `ALLOW_FOREGROUND`, `FILE_ROOTS`) or the tool-surface switch (`TOOLS`); a row that does fails to load.
- **The service.** While the row runs it provides `realBrowser`, the chats' grants, which a plugin that only makes sense beside the driver, such as its skill, injects.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `variant` | `auto` | Which platform binary runs; `auto` picks this computer's. `windows-x64` on Linux runs the Windows binary through WSL. |
| `command` | unset | An absolute program that replaces the binary, such as a test's stand-in server. |
| `args` | `["mcp"]` | The program's arguments. |
| `inheritEnv` | `[]` | Names, without the `OPENCODE_BROWSER_` prefix, of the person's browse variables that reach the server. |
| `toolCallTimeoutMs` | unset | A per-call timeout for browse's tools. |
| `awayDays` | 7 | How many days the away permission lasts, 1 to 30. |

A row whose binary is missing, or whose computer has no browse build, fails to load and names the variant. The browse pack installs `@opencode/browse` and its platform packages; this package does not depend on them.

## Surfaces

- **Approval card.** The `real-browser` card shows the agent's task and what it can reach, in English and Chinese.
- **Routes.** `POST /api/delorunRealBrowser.state` and `.end` read and end a chat's grant from any approved device; `.away` turns the away permission on or off and needs a device unlocked with a code or PIN, not the approval grace ([routes](src/routes.ts), [messages](src/wire.ts)). A request the home cannot place is refused with `LOOPBACK_REQUIRED` before its body is read.

## Known limitations

- Once allowed, the agent acts in the person's browser with their sign-ins; the grant limits which chats and turns may use it, not which sites.
- The environment rules apply to the browse server Delorun starts. A browse relay the person already runs keeps its own settings.

## Tests

[`tests/grant.spec.ts`](tests/grant.spec.ts) drives `use_my_browser` and the guard through the real agent loop, session log and approval service: Allow records the grant naming its ask, "Not now" records none and the browse call is refused, a run nobody can answer and a scheduled run are refused in one sentence, a scheduled run in a granted chat is admitted only while the away permission runs and its lapse is logged once, turning it off ends both, and the grant survives a restart from the log. [`tests/plugin.spec.ts`](tests/plugin.spec.ts) runs the whole row against a stand-in browse server: no grant starts no server, Allow starts it for that chat alone before the next step, and turning it off stops it. [`tests/routes.spec.ts`](tests/routes.spec.ts) covers each route's level, including the away permission refused to a locked device and to one in its grace, and [`tests/config.spec.ts`](tests/config.spec.ts) the binary's resolution and the environment's denials. The answer guard is covered in `delorun/packages/home-auth/tests/authenticator.spec.ts`.
