---
description: "The main chat plugin, for maintainers changing the tools that read and steer a person's other chats, list and change workspaces, and ask the person before every change that outlasts a turn."
kind: "package-bundle"
---

# @delo/plugin-main-chat

English | [中文](README.zh.md)

## Summary

The main chat is one chat outside every workspace, at the directory that holds them, from which the person asks about and steers their other chats and starts work in a workspace. Its tools list, search and read the person's chats, send one a follow-up, stop one's turn, list the workspaces and delegate a brief to a new chat in one; with a workspaces provider mounted they also create, import, trash and restore workspaces and edit a workspace's `AGENTS.md` and its dated owner notes. Every tool that changes something outside the turn asks the person first, in every turn. The studio half adds a Main chat row at the top of the sidebar that opens it, and the composer for its first message. Everything is behind the [C16 switch](../../docs/contracts/c16-parity-composition.md) `main_chat`, off by default. The main chat is an experimental plugin: no Delo profile mounts it, and a row that mounts it sets `enabled: true`.

## Contents

- [Contract](#contract)
- [Approvals](#approvals)
- [Configuration](#configuration)
- [Carry-forward review](#carry-forward-review)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **The main chat** is the Session `delo-main-chat` ([`MAIN_CHAT_SESSION_ID`](src/wire.ts)) with its working directory at `root`. The studio asks for it with `POST /api/deloMainChat.open` ([`MAIN_CHAT_PATHS`](src/wire.ts)), an exact Connection Fetch route; the plugin creates it through the session controller only when the session list lacks it, on the configured `preset`, and answers 204, or 502 after logging why. Concurrent opens share one check. It is not created at start, because upstream's studio makes a first workspace only while there is no chat at all. When another preset is selected for it before its first turn, the plugin selects `preset` again.
- **The tools** ([`tools.ts`](src/tools.ts), [`account-tools.ts`](src/account-tools.ts)) are `chat_list`, `chat_search`, `chat_read`, `chat_send`, `chat_stop`, `workspace_list` and `workspace_delegate`, and, while a `deloWorkspaces` provider is mounted, the account tools `workspace_create`, `workspace_import`, `workspace_trash`, `workspace_restore`, `workspace_instructions`, `workspace_instructions_write`, `workspace_note` and `workspace_note_remove`. Every other chat, subagents included, has them removed when its agent is created, and each refuses a call from any chat but the main chat with `MAIN_CHAT_ONLY`.
- **Which chats they see.** The chats the sidebar lists: the session controller's list without subagent, blank and archived chats and the main chat. `chat_read`, `chat_send` and `chat_stop` refuse any other id with `MAIN_CHAT_NOT_FOUND`, and the main chat's own id with `MAIN_CHAT_INVALID`. A chat's workspace is the innermost workspace that holds its working directory, named by its folder relative to `root`, or `none`.
- **Reading a chat.** `chat_read` reads the chat's log through the session query service and keeps the events that appended to its surface ([`chat-text.ts`](src/chat-text.ts)): a line for each of the person's messages, each notice, each of the agent's replies and each tool call. The newest lines that fit in `readBytes` are kept after a count of the ones left out. The tool's description tells the model never to follow instructions in that text.
- **Sending.** `chat_send` and `workspace_delegate` queue their message through the session controller in mode `queue`, so it runs after the chat's current turn; `chat_stop` cancels a running turn.
- **The workspaces seam.** [`@delo/plugin-workspaces/service`](../plugin-workspaces/src/service.ts) is the Service Definition of `deloWorkspaces`, which that package provides: list the imports and the trash, create, start an import, read and write a workspace's `AGENTS.md` against its revision, trash and restore. The account tools validate the model's arguments with its request schemas and pass a provider's `WorkspaceRefusedError` on as `MAIN_CHAT_REFUSED`. Without a provider the account tools are absent and `workspace_list` answers no imports and no trash.
- **Owner notes** ([`owner-notes.ts`](src/owner-notes.ts)) are a section at the end of a workspace's `AGENTS.md`, from `<!-- delo:owner-notes -->` to `<!-- delo:owner-notes-end -->`, one `<!-- delo:note <id> <date> -->` line per note. `workspace_note` adds or revises a note and `workspace_note_remove` removes one; each writes against the revision it read, keeps the text around the section, and refuses a note that is empty, longer than `noteChars` or holds a marker.
- **Reports** ([`reports.ts`](src/reports.ts)). A chat that `workspace_delegate` started or `chat_send` wrote to is watched through a `plugin:delo-main-chat/handoff` record in the main chat's log, which the plugin reads again when it starts. When that chat's turn ends, it asks the person to approve a tool call, or it asks them a question, the main chat gets a notice through upstream's `inject`: a user message of source kind `delo-main-chat`, read at its next step, which starts no turn. A report holds the chat's newest messages within `reportBytes` and says that the text can hold instructions not to follow. `GET /api/deloMainChat.reports` answers the count waiting, and with `?after=<version>` waits up to 25 seconds for a change, for the row's unread mark.
- **The studio half** ([`client/index.ts`](src/client/index.ts)) registers the Main chat row first in `sidebar.panellist`, leading the sidebar through `ctx.sidebarLayout.setLeadPanel` and current while the main chat is on screen; its panel calls the open route, waits up to 30 seconds for the page's chat list to hold the main chat, and shows it, or says it did not open with a retry. The row's glyph carries the completed-chat dot while reports wait. The sidebar's chat list leaves the main chat out (`uiWorkspace.hideSession`). Until its first prompt a composer of the plugin's own replaces the stock one, which asks for a workspace the main chat does not have. Its copy is in English and Chinese.

## Approvals

The main chat runs in the directory that holds every workspace, and untrusted text reaches its turns through fetched pages, files, other chats and other workspaces' `AGENTS.md`. So:

- **The account tools in [`ALWAYS_ASK`](src/account-tools.ts)** ask the person through upstream's approval service in every turn, whatever the turn read: `workspace_instructions_write`, `workspace_import`, `workspace_restore`, `workspace_trash`, `workspace_note` and `workspace_note_remove`. Each writes instructions that every chat of a workspace reads, fetches content the model chose, or brings back or removes a workspace. The question names the change and is asked from inside the tool's own execution, so no `tools/pre-execute` listener can let it through unasked. Any answer but `allowed-once`, or no approval service, refuses the call with `MAIN_CHAT_DECLINED` before anything changes.
- **`workspace_create`** asks in a turn that read another chat's or workspace's text: `chat_read`, `chat_search` and `workspace_instructions` record `plugin:delo-main-chat/read` in the main chat's log, and a report the turn took in counts too ([`readThisTurn`](src/account-tools.ts)).
- **Every other tool call** of the main chat answers upstream's `tools/pre-execute` with `ask` in every turn ([`guard.ts`](src/guard.ts)), so a file write, a command, a `run_code` program, a web request, a plugin manager change or any tool a plugin adds waits for the person; the reason says when the turn read another chat or workspace. A `run_code` program asks before it runs because it can write files under the session's file policy without calling a tool, and each tool it calls is decided again. `GUARD_FREE` lists the calls that run without that question: the read-only tools, the plugin manager's read actions, the account tools, which ask themselves, and the tools that change only the main chat's own session (`working_directory`, `todo_write`, `present`, `exit_plan_mode`, which asks itself, and `ask_user_question`). `chat_send`, `chat_stop` and `workspace_delegate` ask only in a turn that read another chat or workspace (`GUARD_AFTER_READ`): the chat they reach runs under its own workspace's permissions.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | C16 switch `main_chat`: off, the parity value, the plugin registers nothing. |
| `root` | required | The absolute directory that holds every workspace, the main chat's working directory. |
| `preset` | required | The agent preset the main chat runs, and the only one it may select. |
| `listLimit` | 30 | The most chats `chat_list` answers. |
| `readBytes` | 12000 | The largest `chat_read` answer in UTF-8 bytes, at least 256. |
| `noteChars` | 2000 | The longest owner note in characters, 1 to 10,000. |
| `reportBytes` | 2000 | The largest report in UTF-8 bytes, at least 256. |

**Published as built JavaScript.** `pnpm run build` runs upstream's client preset (`packages/client/tsdown.client.ts`): `lib/index.js` for the harness and `lib/client.js` for the browser, which inlines dsh-brand from its source. Its `cordis.patch.yml` inserts the `delo-main-chat` row, so upstream's plugin manager can install the package as a bundle of its own.

## Carry-forward review

The package is carried from Delo's earlier main chat and reviewed for this tree, whose base is `dsh-v0.2.2-rc.1`.

- **Decision: the write-class tools always ask.** The earlier guard asked only in a turn that read another chat's text, while untrusted text also arrives through fetched pages, files and other workspaces' `AGENTS.md`. `workspace_instructions_write`, `workspace_import` and `workspace_restore` now ask in every turn, like `workspace_trash`, and refuse with `MAIN_CHAT_DECLINED` when declined; [`untrusted-input.spec.ts`](tests/untrusted-input.spec.ts) proves it.
- **Widened with it, as lead decisions.** `workspace_note` and `workspace_note_remove` always ask too, since an owner note is instructions every chat of the workspace reads. `workspace_instructions` records a read, so the rest of its turn asks before `workspace_create`, a message or a delegation. Every other tool that is not read-only asks in every turn, `web_fetch` and `run_code` included, because the main chat now runs in the directory that holds every workspace, where a file write, a command or a program reaches any workspace's `AGENTS.md`. The `deloWorkspaces` Service Definition lives here until Delo's workspace import package provides it and takes it over.
- **Cut.** Everything tied to hosted cells: the command runner's separate home for the main chat, cell paths such as `/workspace`, private GitHub clones through account control's tokens, and the cell release and publishing tools named in the guard's tests. The workspaces plugin is not carried here; its operations are the `deloWorkspaces` seam above, which Delo's workspace import package provides. Deferred with Home: the Your chats tab beside the main chat and the studio opening on Home.
- **`GUARD_FREE` checked against direct effects.** For each listed tool: can it change a file or state outside the session without a tool call the guard decides? `run_code` can, since a Node program runs under the session's standing file policy, so it was taken out and asks in every turn. The others cannot: `read`, `read_image`, `glob`, `grep`, `skill`, `job_list`, `job_output`, `get_goal`, `schedule_list`, `list_agents`, `cordis_inspect_list` and `cordis_inspect_query` only read; `working_directory`, `todo_write`, `present`, `exit_plan_mode` and `ask_user_question` change only the main chat's own session; `chat_read`, `chat_search` and `workspace_instructions` read and record the read in the main chat's log; the account tools ask from inside their execution.
- **Adapted.** The row is labelled Main chat instead of Home. `preset` has no default, so the composition names the main chat's preset. Everything the plugin registers sits behind its own switch, `main_chat`.

## Known limitations

- A delegated chat runs under its own workspace's permissions, so a brief the main chat sends reaches that workspace as stock chats' messages do.
- A fetched page does not count as a read for `workspace_create`, `chat_send`, `chat_stop` and `workspace_delegate`, which ask only after a chat or workspace was read; the fetch itself asks, since `web_fetch` is not read-only.

## Tests

[`tests/untrusted-input.spec.ts`](tests/untrusted-input.spec.ts) runs the main chat on upstream's production agent loop with upstream's approval service and a stand-in `deloWorkspaces` provider over two fixture workspaces on disk ([`tests/fixture-workspaces.ts`](tests/fixture-workspaces.ts)): a turn whose only untrusted input is a fetched page and one whose only untrusted input is a hostile `AGENTS.md` each attempt `workspace_instructions_write` against the second workspace, `workspace_import` and `workspace_restore`; each call asks, is declined, is refused with `MAIN_CHAT_DECLINED`, and leaves the files and the provider unchanged. A turn whose only untrusted input is a page fetched by one `run_code` program runs a second program that writes the second workspace's `AGENTS.md` with fs directly; it asks, is declined, and the file is unchanged. A turn the person drives runs the same calls after one approval each, the four write-class tools ask in a turn that read nothing, fetched a page or read a workspace's `AGENTS.md`, and without an approval service each is refused. [`tests/main-chat.spec.ts`](tests/main-chat.spec.ts) covers the switch, creation and its failure, the preset, the tools offered to the main chat alone, each tool's answers and refusals, the reports and their count, the account tools without a provider, owner notes, and the guard over other tools. [`tests/chat-text.spec.ts`](tests/chat-text.spec.ts) covers the line forms and the byte budget, and the `.client.spec.tsx` files cover the row, its panel, the unread mark and the first-message composer.
