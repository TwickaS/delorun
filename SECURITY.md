# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. If you cannot use that route, email support@delorun.com with "security" in the subject.

Never report a vulnerability in a public issue, discussion or pull request, and do not post exploit details in one.

## Supported releases

Delo supports its latest release. While Delo has no release, it supports the latest pre-release. Earlier releases do not receive security fixes, so install the latest release to receive them.

## Dependency advisories

Delo watches advisories for every package in the dependency closure of each release: the packages a released Delo installs, including transitive dependencies. Dependabot alerts and the npm advisory database are checked against the repository's lockfile. A dependency-only fix ships as a patch release that changes no other code.

## Plugins

Delo does not audit plugins before you install them. A catalogue entry shows what an author or a reviewer claims about a plugin, and Delo does not verify those claims.

## Goal and threat model

Delo aims never to be less safe than stock DeepSeek Harness (DSH). Delo's threat model, which states what each party can see and do, will be published at `delo/docs/security/threat-model.md`.
