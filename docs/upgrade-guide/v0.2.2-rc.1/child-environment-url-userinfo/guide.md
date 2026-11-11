---
kind: upgrade-guide
description: "A child process no longer inherits a variable whose value holds a URL with any user information, a user name alone included, or a newly denied credential name."
---

# Children no longer inherit URLs with user information

English | [中文](guide.zh.md)

## Change

`scrubbedParentEnv()` in `@deepseek-ai/dsh-subprocess` decides which of the harness's own environment variables a child process inherits: shell commands, MCP stdio servers, language servers and subagent CLIs. Before, a value was dropped for URL user information only in the form `scheme://user:secret@`. Now any user information after `scheme://` drops the variable, a user name alone included, because a token in that place cannot be told from a login: `https://<token>@host`, a Sentry DSN, `ssh://git@host/repo` and `postgres://user@db/app` are no longer inherited. A scp-style `git@host:org/repo` has no scheme and is still inherited, as is a URL whose `@` lies in its query or fragment.

The names `KUBECONFIG`, `KRB5CCNAME`, `*_CREDENTIALS`, `*PASSPHRASE*` and `MYSQL_PWD` are no longer inherited either. A `*PATH` search list, such as `PATH` or `PYTHONPATH`, now loses only an element that names a credential file or an agent socket, where before such an element dropped the whole variable.

This affects workflows in which a command, MCP server or other child relied on inheriting one of these variables from the environment the harness was started in.

## Migration

1. Pass the value explicitly where the child is configured: the `env` of an MCP server row, the `env` of a subagent or language-server row, or the command itself, such as `DATABASE_URL=postgres://user@db/app psql`. Explicit `env` entries merge after the scrub and reach the child unchanged.
2. Prefer a URL without user information plus a separate credential variable the child reads, where the tool supports it.
3. Confirm by printing the variable from the child, for example `printenv DATABASE_URL` through the shell tool: it prints the value you passed.
