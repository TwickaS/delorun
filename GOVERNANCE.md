# Governance

## Maintainers

Delo has one maintainer today. That person decides what merges, holds the release keys and makes the releases. The maintainer handles reports under the [Code of Conduct](CODE_OF_CONDUCT.md) and the [security policy](SECURITY.md). Review requests for the paths listed in [CODEOWNERS](.github/CODEOWNERS) go to the maintainers team named there. Delo Run is the organisation that maintains Delo.

## Decisions

The maintainer decides which changes Delo merges. A decision about Delo's direction is recorded as an Agent Note in [.agents/notes/](.agents/notes/README.md), which states the decision, its reason, what it gives up and how it is verified. Mechanical and local changes need no Agent Note. A change that would break loading stock DeepSeek Harness plugins, profiles or sessions needs such a decision.

Delo's [security fundamentals](delo/docs/security/fundamentals.md) change only by a maintainer decision recorded as an Agent Note, together with a changelog fragment in the Security section. Later work may make a fundamental stricter; nothing weakens or removes one without that decision.

Pull requests merge by rebase, with authors and sign-offs kept and a linear history ([CONTRIBUTING.md](CONTRIBUTING.md#pull-requests)).

## Becoming a maintainer

Other maintainers join by invitation, after sustained contributions that the current maintainers reviewed. There is no application process and no fixed number of maintainers. An invitation does not promise a role or a response time, and a maintainer may step down at any time.

## Response times

Delo is a small project. Maintainers review contributions as they can, and Delo does not promise a response time for issues, discussions, pull requests or reports.

## Supported versions

While versions are 0.x, security fixes go to the latest release only ([SECURITY.md](SECURITY.md#supported-versions)).

## Before 1.0

These items are open and are not satisfied today:

- A key-succession statement: who can sign and publish releases if the maintainer cannot.
- A second maintainer, or a published reason why there is none.

## Changes to this document

Changes to this document go through pull requests and receive the same review as code.
