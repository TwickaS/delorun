---
description: "Starts a chat when a signed GitHub webhook arrives. Needs a secret in DELORUN_GITHUB_WEBHOOK_SECRET and a rule of your own."
---

# @delorun/bundle-webhooks

## Summary

Switch on **Webhooks** in Plugins to let a signed GitHub webhook start a chat. The endpoint `POST /github` listens on `127.0.0.1:3081` only; to receive GitHub's calls you put a TLS reverse proxy or tunnel in front of it yourself.

Two things are yours to supply. Set `DELORUN_GITHUB_WEBHOOK_SECRET` (a high-entropy secret, the same one in GitHub's webhook settings) before starting Delorun; until it is set the endpoint does not start. And add a rule in your profile that says which delivery creates which chat; the bundle ships none, so a verified delivery on its own does nothing. Set `DELORUN_GITHUB_WEBHOOK_PORT` to change the port. It is experimental and opens a network listener, so read the GitHub review guide first.

## Needs setup

- Needs DELORUN_GITHUB_WEBHOOK_SECRET in the environment and a rule of your own; without the secret the endpoint does not start.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
