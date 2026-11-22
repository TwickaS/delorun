# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately by email to security@delorun.com, or with GitHub's private report form: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version, the steps to reproduce it and what an attacker gains.

The maintainer aims to acknowledge a report within three working days and to say when a fix is expected. The promise covers the acknowledgement and that statement, not the fix: how long a fix takes depends on the problem.

Never report a vulnerability in a public issue, discussion or pull request, and do not post exploit details in one. Delorun pays no bounty.

## Scope

In scope is a vulnerability in Delorun's own code under `delorun/`, in how Delorun configures or composes upstream's code, or in a Delorun release artifact. These areas matter most:

- The sandbox: a confined command that reads, writes or reaches something its policy denies.
- Approvals: an action that runs without the approval the policy requires, or an approval that applies to more than the person saw.
- Remote access: a way to reach a Delorun home, a session or a phone link without the pairing and sign-in that grant access.
- Update verification: a release or update that Delorun installs without a valid signature and checksum.

A vulnerability in DeepSeek Harness's own code is in scope for reporting here too, because the maintainers handle it as described next. A plugin by a third-party author is the author's responsibility; see [Plugins](#plugins).

## Vulnerabilities in upstream code

The maintainers report a vulnerability in DeepSeek Harness's code privately to its maintainers at the same time as they fix it here. Delorun does not publish details before upstream has had 30 days. The maintainers may shorten that period when a fix is already public.

## Outside review

Nobody outside the project has reviewed Delorun's security, and releases are signed with preview keys. [What you trust when you use Delorun](delorun/docs/guide/safety-and-updates/trust.md) explains what that means.

## Supported versions

Only the newest release receives security fixes. Install the newest release to receive them. Delorun promises no fix time; a report's acknowledgement is described under [Reporting a vulnerability](#reporting-a-vulnerability).

## Dependency advisories

Before each release is signed, its runtime lockfile's npm packages, including transitive dependencies, are checked against the GitHub Advisory Database, and the release stops on an advisory that has no reviewed acceptance. Dependabot alerts and the npm advisory database are also checked against the repository's lockfile. The advisory check does not cover the pinned Node binary, the native addon's compiler and linker, the system packages of the S2 and S3 container images, or the Python and Office payloads the desktop app carries. A dependency-only fix ships as a patch release that changes no other code.

## Plugins

Delorun does not audit plugins before you install them. A catalogue entry shows what an author or a reviewer claims about a plugin, and Delorun does not verify those claims.

## Goal and threat model

Delorun aims never to be less safe than stock DeepSeek Harness (DSH). Delorun's [threat model](delorun/docs/security/threat-model.md) states what each party can see and do. The [security fundamentals](delorun/docs/security/fundamentals.md) list the rules Delorun holds itself to, each with the code that enforces it and the test that proves it.
