# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. If you cannot use that route, email support@delorun.com with "security" in the subject.

Never report a vulnerability in a public issue, discussion or pull request, and do not post exploit details in one.

## Supported releases

Delo supports its latest release. While Delo has no release, it supports the latest pre-release. Earlier releases do not receive security fixes, so install the latest release to receive them.

## Dependency advisories

Before each release is signed, its runtime lockfile's npm packages, including transitive dependencies, are checked against the GitHub Advisory Database, and the release stops on an advisory that has no reviewed acceptance. Dependabot alerts and the npm advisory database are also checked against the repository's lockfile. The advisory check does not cover the pinned Node binary, the native addon's compiler and linker, the system packages of the S2 and S3 container images, or the Python and Office payloads the desktop app carries. A dependency-only fix ships as a patch release that changes no other code.

## Plugins

Delo does not audit plugins before you install them. A catalogue entry shows what an author or a reviewer claims about a plugin, and Delo does not verify those claims.

## Goal and threat model

Delo aims never to be less safe than stock DeepSeek Harness (DSH). Delo's [threat model](delo/docs/security/threat-model.md) states what each party can see and do.
