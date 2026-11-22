# Governance

## Maintainers

Delorun is its own product, and it has one maintainer. That person decides what merges, holds the release keys, signs and publishes every release, and answers the support address. The maintainer handles reports under the [Code of Conduct](CODE_OF_CONDUCT.md) and the [security policy](SECURITY.md). Review requests for the paths listed in [CODEOWNERS](.github/CODEOWNERS) go to the maintainers team named there.

## Decisions

The maintainer decides which changes Delorun merges. A decision about Delorun's direction is recorded as an Agent Note in [.agents/notes/](.agents/notes/README.md), which states the decision, its reason, what it gives up and how it is verified. Mechanical and local changes need no Agent Note. A change that would break loading stock DeepSeek Harness plugins, profiles or sessions needs such a decision.

Delorun's [security fundamentals](delorun/docs/security/fundamentals.md) change only by a maintainer decision recorded as an Agent Note, together with a changelog fragment in the Security section. Later work may make a fundamental stricter; nothing weakens or removes one without that decision.

Pull requests merge by rebase, with authors and sign-offs kept and a linear history ([CONTRIBUTING.md](CONTRIBUTING.md#pull-requests)).

## Becoming a maintainer

Other maintainers join by invitation, after sustained contributions that the current maintainers reviewed. There is no application process and no fixed number of maintainers. A person who lands several good changes is offered the role. Release signing stays with the maintainer who holds the keys. An invitation does not promise a role or a response time, and a maintainer may step down at any time.

## Response times

The maintainer tries to reply as soon as possible, usually within a day or two, and sometimes longer. Delorun does not promise a response time for issues, discussions or pull requests. A security report is the one exception, and it promises an acknowledgement, not a fix ([SECURITY.md](SECURITY.md#reporting-a-vulnerability)).

## Supported versions

While versions are 0.x, security fixes go to the latest release only ([SECURITY.md](SECURITY.md#supported-versions)).

## If the maintainer cannot act

Only the maintainer can sign and publish a release, so releases stop if he cannot act. Nothing else stops. The releases you have installed keep running and keep passing `delorun verify`, because their signatures and the public release log do not expire with the maintainer. The update check finds no newer release. The code is MIT-licensed, so anyone may fork it and publish releases under their own name and keys. The project names no other person who may sign.

## Before 1.0

These items are open and are not satisfied today:

- A second person who can sign and publish releases, or a published reason why there is none.
- The key ceremony for production keys, which comes with `1.0.0` ([What you trust when you use Delorun](delorun/docs/guide/safety-and-updates/trust.md#how-releases-are-signed-in-the-preview)).

## Changes to this document

Changes to this document go through pull requests and receive the same review as code.
