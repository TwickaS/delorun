# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. If you cannot use that route, email support@delorun.com with "security" in the subject.

Never report a vulnerability in a public issue, discussion or pull request, and do not post exploit details in one. Delo pays no bounty.

## Scope

In scope is a vulnerability in Delo's own code under `delo/`, in how Delo configures or composes upstream's code, or in a Delo release artifact. A vulnerability in DeepSeek Harness's own code is in scope for reporting here too, because the maintainers handle it as described next. A plugin by a third-party author is the author's responsibility; see [Plugins](#plugins).

## Vulnerabilities in upstream code

The maintainers report a vulnerability in DeepSeek Harness's code privately to its maintainers at the same time as they fix it here. Delo does not publish details before upstream has had 30 days. The maintainers may shorten that period when a fix is already public.

## Outside review

No outside security review of Delo has happened yet.

## Supported versions

While Delo's versions are 0.x, only the latest release receives security fixes. While Delo has no release, the latest pre-release is supported. Install the latest release to receive fixes. Delo does not promise a response time.

## Dependency advisories

Before each release is signed, its runtime lockfile's npm packages, including transitive dependencies, are checked against the GitHub Advisory Database, and the release stops on an advisory that has no reviewed acceptance. Dependabot alerts and the npm advisory database are also checked against the repository's lockfile. The advisory check does not cover the pinned Node binary, the native addon's compiler and linker, the system packages of the S2 and S3 container images, or the Python and Office payloads the desktop app carries. A dependency-only fix ships as a patch release that changes no other code.

## Plugins

Delo does not audit plugins before you install them. A catalogue entry shows what an author or a reviewer claims about a plugin, and Delo does not verify those claims.

## Goal and threat model

Delo aims never to be less safe than stock DeepSeek Harness (DSH). Delo's [threat model](delo/docs/security/threat-model.md) states what each party can see and do. The [security fundamentals](delo/docs/security/fundamentals.md) list the rules Delo holds itself to, each with the code that enforces it and the test that proves it.
