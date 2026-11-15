---
description: "Recipe for the maintainer when a published Delorun release is broken or tampered with: stop it spreading, publish a fixed release, post a notice on the repository and the site, give people the command that returns them to the previous version, and rehearse the whole plan on a test channel."
---

# Handle a bad release

English | [中文](bad-release.zh.md)

## Summary

This recipe is for the maintainer. It covers a published release that breaks people's installations or that someone tampered with. It ends with a fixed release published, a notice posted on the repository and the site, and people who installed the bad release back on a good one. You need the release signing keys, the npm and GitHub accounts that publish, and a terminal in a checkout of the repository. Publishing is always done by hand with a second factor, so an agent can prepare the steps but cannot run them for you.

## Contents

- [What people already have](#what-people-already-have)
- [The steps](#the-steps)
- [The command for people](#the-command-for-people)
- [Rehearse on a test channel](#rehearse-on-a-test-channel)

## What people already have

Delorun protects most installations before you act:

- An update checks the new release after it switches. When the health check fails, Delorun goes back on its own to the release and profile the person had ([Updates](../guide/updates.md#what-happens-during-an-update)).
- Delorun keeps two releases installed, the running one and the one before, so a person can go back one release.
- No release channel moves to a lower version, so a bad release cannot be withdrawn by pointing the channel at an older one. A fixed release has to carry a higher version.

## The steps

1. **Decide which case it is.** A broken release fails for ordinary reasons. A tampered release, or a signing key that someone else may hold, is a security incident: also follow [SECURITY.md](../../../SECURITY.md) and, for a key, the rotation rules of [the release manifest contract](../contracts/c02-release-manifest.md).
2. **Stop it spreading.** Deprecate the bad launcher on npm with `npm deprecate delorun@<bad-version> "<one-line reason>"`, and move the `latest` tag back to the last good version with `npm dist-tag add delorun@<good-version> latest`, so that `npx delorun` installs a good launcher. On the GitHub release of the bad version, edit the notes to say that the release is withdrawn and why. Leave its files and its entry in the public release log in place: the log is a record, and it stays.
3. **Publish a fixed release.** Fix the problem on the release branch, cut a release with a higher version, with the full checks and the dependency advisory check, and publish it by hand. The channel's timestamp then names the fixed release, and installations offer it at their next update check.
4. **Post a notice.** Post it on the repository (a pinned issue, and a Discussions announcement) and on the site. It says which version is bad, what happens to a person who installed it, the fixed version, and the command below. For a tampered release it also says what to check: `delorun verify` and the release log entry.
5. **Check that people can leave the bad version.** On a machine with the bad version installed, run the command below and check that Delorun runs the previous release, and that `delorun update` offers the fixed one.
6. **Close the incident.** Record what happened in a postmortem, and add the check that would have caught it.

## The command for people

A person who installed the bad release and has not yet updated runs:

```sh
delorun recover rollback
```

It goes back to the release before the last update, with the profile snapshot taken before it. It works whether Delorun is running or not. If the update changed the format of chat data, it sets the newer data aside and puts the copy taken before the update back. Without that copy it refuses with `ROLLBACK_NEEDS_DATA_COPY`, and `delorun recover rollback --profile-only` restores only the profile ([Updates](../guide/updates.md#going-back)). Once the fixed release is out, `delorun update` moves the person forward.

## Rehearse on a test channel

Rehearse the plan once before the first public release, and again after the release process changes:

1. Serve a test channel as the local release channel section of the [release tooling README](../../apps/release/README.md) describes, and install a release from it.
2. Publish a second release to the channel, then make the second release the "bad" one.
3. Walk the steps above: build the fixed third release, run the command on the installed copy, and check that the installation ends on the previous release and then updates to the fixed one.
4. Write down anything that was unclear, and fix this page.

**Verify.** After the rehearsal, `delorun --version` reports the fixed release, `delorun recover status` reports the last update, and `delorun verify` passes.
