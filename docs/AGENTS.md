# AGENTS.md — The documentation standard

This file defines document structure, Markdown tiers, writing rules, and `verify-doc-budgets` ceilings. Use [dsh-doc-writing](../.agents/skills/dsh-doc-writing/SKILL.md) for placement and validation, and [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for required coverage and editorial judgment; the [archived doc-tiers Agent Note](../.agents/notes/archived/process/2026-07-04-doc-tiers-and-budgets.md) records the historical rationale. These rules govern Delorun's documentation under `delorun/` as they govern upstream's; the sections below name the Delorun tiers, Delorun's website and the wording Delorun's trust promises require.

## Document structure

These rules apply to human-facing documentation; [Agent Notes](../.agents/notes/README.md) remain outside their scope. A [postmortem](postmortem/README.md) is an incident-scoped reference; chronology records evidence, not a teaching sequence. A document's subject and tree position fix its scope: describe its own subject at appropriate detail and direct children only by purpose, responsibility, and high-level behavior; link to the owning descendant for lower-level detail. Document type does not widen that scope. A reference may be exhaustive only about its own subject. Testing mechanisms, fixtures, and harnesses belong at the lowest owning level; higher documents link there.

Classify every in-scope document as a tutorial or reference. Tutorials follow an ordered path to an outcome and introduce only what each step needs. References define a lookup scope and current behavior without a teaching sequence. Separate substantial tutorial and reference content; label a section when either part is small.

Before writing a tutorial, privately classify the reader's starting knowledge and each concept as beginner, intermediate, or advanced. Establish prerequisites before dependent concepts, increase difficulty gradually, and move unnecessary advanced material to a later tutorial or reference.

Author in this order: locate the document in the tree; set its permitted detail; choose tutorial or reference; for a tutorial, order concepts by prerequisite and difficulty; relocate descendant-owned detail; replace lower-level explanations with links to their owners.

## The tier taxonomy: one home per fact

Each fact has one home: the tier whose job it is; elsewhere, link there.

| Tier | Job | Does NOT belong there |
|---|---|---|
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, linking its home | Stories, worked examples, situational procedures, anything restated from a linked home |
| Subtree `AGENTS.md` (`packages/`, `docs/`, `.agents/notes/`) | Orders specific to that subtree | Repo-wide rules the root file already carries |
| [architecture.md](architecture.md) | Ordered map: composition, core packages, loop, seams, extension points; read before changing `packages/` | Type definitions (→ subsystems), per-package detail (→ package READMEs), decision rationale (→ Agent Notes), implementation-status annotations |
| [subsystems/](subsystems/README.md) | One reference page per subsystem: type definitions, semantics, and the generated Cordis API | Behavior narration (→ architecture.md) |
| [Agent Notes](../.agents/notes/README.md) | Active decision records: the why, what-was-given-up, and required verification; `implemented/` notes describe shipped reality in present tense | Migration plans, acceptance-task checklists, fixture walkthroughs, and spec-speak ("should…") once the decision has shipped; archived notes are frozen history, never current authority |
| [defensive-patterns/](defensive-patterns/README.md) | Rules this repository enforces in review, split by artifact: one general bug-class page plus per-domain pages | Type definitions and semantics (→ subsystems), decision rationale (→ Agent Notes) |
| [postmortem/](postmortem/README.md) | Incident stories — the only tier where war-story narrative belongs | — |
| [Persistence history](persistence-changes/README.md) and [format references](persistence-changes/historical-formats/README.md) | Type-change acknowledgements, release comparisons, and complete historical format schemas | Behavior-only changes; current runtime contracts |
| [cookbook/](cookbook/adding-a-package.md) | Step-by-step how-tos with numbered verify steps | Design rationale (→ the Agent Note each guide links) |
| [user/](user/index.md) | Product-facing guides published by the documentation website | Generated reference tables, contributor procedures, decision history |
| [delorun/docs/guide/](../delorun/docs/guide/README.md) | Delorun's user guide, published by Delorun's documentation website: what each feature does, how to use it, what it exposes, its limits and how to undo it; the Delorun vs stock DSH page holds the roadmap, ordered by stage, which root `ROADMAP.md` links | Contributor procedures, decision history |
| [delorun/docs/cookbook/](../delorun/docs/cookbook/README.md) | Step-by-step how-tos for work on Delorun with numbered verify steps | Design rationale (→ the Agent Note each guide links) |
| [delorun/docs/reference/](../delorun/docs/reference/README.md), [delorun/docs/contracts/](../delorun/docs/contracts/README.md), [delorun/docs/security/](../delorun/docs/security/threat-model.md) | Delorun's references: the glossary, the [parity checklist](../delorun/docs/reference/parity-with-deepseek-harness/parity.md) and divergence records; contract pages that work packages consume as written (purpose, exact types or wire formats, limits, errors, security requirements with their denial tests, consumers); the threat model and release verification | Tutorials, decision rationale (→ Agent Notes) |
| [delorun/docs/defensive-patterns/](../delorun/docs/defensive-patterns/README.md) | Rules Delorun enforces in review of its own code, split by artifact | Rules upstream's `defensive-patterns/` already states |
| [delorun/docs/architecture/](../delorun/docs/architecture/README.md) | Architecture notes: the ordered map of Delorun's packages and extension points in `README.md`, and one current-state page per subsystem, written as it ships; read before changing `delorun/` | Decision rationale (→ Agent Notes), per-package detail (→ package READMEs) |
| `delorun/docs/upgrade-guide/` | Upgrade guides for breaking changes to Delorun's own surfaces, `v<Delorun version>/<item>/guide.md`, written with [dsh-create-upgrade-guide](../.agents/skills/dsh-create-upgrade-guide/SKILL.md) | Breaks in upstream code (→ `upgrade-guide/`) |
| `delorun/changelog/unreleased/` | One fragment per change people can perceive, assembled into release notes | Anything not perceptible |
| `delorun/upstream-patches.json` | The divergence ledger: the upstream tag and every changed or added file outside `delorun/` with its reason and class | Merge instructions (→ divergence records) |
| Skills in `delorun/packages/bundle-*/skills/` | What a person's own agent needs to act on Delorun | Contributor workflow (→ `.agents/skills/`) |
| GitHub issues and milestones | Work in progress and its briefs | Any document in the tree |
| Package README | The per-package contract: config, semantics, limitations, extension points, and [Model Experience](cookbook/adding-a-package.md#4-write-the-package-readme) | JSDoc restatement, generated-catalog restatement (event/tool tables), other packages' concerns |
| [development.md](development.md) | Contributor setup, daily workflow, and a summary of CI; a bilingual pair under the [i18n contract](i18n/README.md) | Runtime/version rationale (→ Agent Notes), check-by-check lists that drift from `package.json` scripts |
| Generated reference: the per-page `cordis-surface` regions in [subsystems/](subsystems/README.md), the [Cordis core API + inherited tier](cordis-api/context.md), [tool-catalog](tool-catalog.md), [config-catalog](config-catalog.md), [persistence-catalog](persistence-catalog.md), [module-graph.md](module-graph.md), [cli-help](cli-help.md) | Exhaustive English sources regenerated from source and freshness-gated; reviewed Chinese counterparts follow the [pairing workflow](i18n/README.md#scope-and-exclusions) | Hand edits to generated English sources or regions; Chinese counterparts update through pairing only |
| Skills (`.agents/skills/`) | Reusable workflows and specialized decision standards | Product and runtime contracts (→ docs or source) |

Placement: bugs → postmortems; rationale → Agent Notes; procedures → cookbooks; type definitions → subsystems; package contracts → READMEs; standing orders → root `AGENTS.md` with a rationale link; review-enforced rules → `defensive-patterns/`. Delorun's code documents in the `delorun/docs/` tiers above; upstream code documents in upstream's tiers, edited in place in the change that edits the code. Delorun's decisions are Agent Notes in `.agents/notes/` beside upstream's. Delorun's working plans are not documents in this tree.

## Writing rules

- **Document current state.** Keep history in commits, PRs, Agent Notes, postmortems, or scoped persistence records. Other prose names live mechanisms, not changes or stack positions. General Session-format prose links [version/status authority](session-format-status.md); retain numbers for version-specific contracts, examples, or evidence.
- **Apply the Agent Note creation criteria.** Mechanical/local edits are exempt, including local UI changes; keep existing owning notes accurate ([scope](../.agents/notes/README.md#when-to-write-one)).
- **One physical line per paragraph** (`verify-md-wrap`): use editor soft-wrap. Code blocks, tables, and list structure keep their formatting; code comments stay under the linter's column limit.
- **Fenced `ts` blocks must compile** (`doc-typecheck`); a pasted type declaration and its original JSDoc use ` ```ts type-equiv `, while a body-stripped public class declaration uses ` ```ts public-api `; register either in the manifest so neither can drift ([mechanics](development.md#documenting-types-verbatim-ts-type-equiv)).
- **The owning [subsystems page](subsystems/README.md) updates in the same change** that reshapes a documented type. `verify-type-equiv` catches drifted pastes, not never-documented new types; a type is documented on its declaring package group's page ([page scoping](../scripts/verify-subsystem-pages.ts)).
- **Pairs update together**: [Terminology-guided](i18n/terminology.md), single-pass active-agent work repositions first-use annotations, preserves untouched prose, and re-records; `dsh-translate-docs` remains user-invoked ([contract](i18n/README.md)).
- **Comments and JSDoc state complete contracts, not reasoning transcripts.** Preserve behavior, failure, timing, ownership, modality, exceptions, consequences, and non-obvious orientation; delete narration, test walkthroughs, review analysis, and code restatement. Keep the local contract and link its rationale. Use [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for details.
- Write directly: name actors and facts ([reference](../.agents/skills/dsh-prose-standard/SKILL.md)). Reserve `seam` for the defined capability. Name the exact check, type, API, operation, or behavior instead of metaphorical "gate", "vocabulary", or "surface".
- **No calendar planning.** Documents carry no schedules, deadlines or time estimates; a date appears only as a record of when something happened or was decided, and a duration only where it defines behaviour (`gates:doc-times`).
- **Delorun's pages are pairs too.** Every page under `delorun/docs/` is an English and Chinese pair with its consistency record under the [i18n contract](i18n/README.md); upstream's gate already covers Delorun's READMEs and Agent Notes, and Delorun's documentation gate runs `verify-translation-pairing`, `verify-md-wrap`, `verify-md-links`, `doc-typecheck` and `verify-doc-budgets` over `delorun/docs/`. Delorun's documentation is English and Chinese only; its screens ship in every upstream language. Feature work edits English only, re-records each pair with `node_modules/.bin/tsx scripts/verify-translation-pairing.ts --write <English file>` so the hooks pass, and lists what needs translating; one translation pass writes the Chinese before a release.
- **Delorun's words.** The [Delorun glossary](../delorun/docs/reference/glossary.md) names each Delorun concept once and upstream's [glossary](glossary.md) owns the harness's terms; pages, skills, interface strings and a plugin's `meta.title` and `meta.description` use those words, and a new concept gets its entry in the same change.
- **A person's agent is a reader.** Delorun's shipped skills (`delorun` in every mode, `delorun-plugins` in Creator) link the website's Markdown pages and `llms.txt`; a change to what a person's agent can do updates them.

## Security and trust wording

Delorun's pages, interface text and skills describe trust exactly; review rejects these failures:

- A label such as "secure" or "private" without the statement of what each party can and cannot see or do. "Zero-trust" describes only reach with no Delorun involvement (Tailscale, a self-hosted relay); the Delorun relay gets exact statements.
- Omitted residual trust: Delorun's releases, Delorun-controlled names and certificates, the identity provider, the catalogue.
- The desktop app called end-to-end through every relay; it pins the home's TLS leaf key, on homes that keep one across certificate renewals.
- Own-domain reach called end-to-end beyond its conditions: the CAA record binds issuance to the home's ACME account (`accounturi`), the home answers no certificate challenge through a relay, and only the RFC 8657 parameters the named CA enforces are claimed.
- Native confinement overstated: file writes are confined, and reads of Delorun's secrets and tokens, and connections to its control sockets and the Docker socket, are denied where the dialect enforces it, which `delorun verify` reports; other Unix sockets and the network are not confined. The fetch guard limits `web_fetch`'s targets, not what commands can reach.
- A claim that Delorun audits plugins. Findings a catalogue entry lists are the author's or a reviewer's claims, which Delorun does not verify, and the page says so where it shows them.
- Certificate monitoring promised without its delay: detection follows a log's inclusion of the certificate, a delay each log's inclusion policy bounds.
- Telemetry described before it ships. Delorun has no telemetry of its own. Upstream's desktop analytics and DeepSeek session-log upload are on by default in upstream's own profiles; Delorun's CLI profiles turn both off through `@delorun/bundle-local` until the person opts in on its Privacy screen.
- Recovery stated without its configuration: with an identity factor, the recovery kit and the home's terminal; without one, the terminal only.
- A badge other than "tested with Delorun X" with the release named, or a rebuild called "independent" rather than "reproduced from the tagged source with the published recipe" by the signer on a machine outside CI.
- A limit called "enforced" without a test that proves it on that runtime; otherwise it is advisory. Native mode always says commands run with the person's own access.

## Delorun's user guide

Guide pages use plain English, with a glossary link on a term's first use. Each task has a short main path, then folded `<details>` blocks titled "Edge cases" and "Go further". Every page says what it helps you do, what you need first, what you should see and the fix for each error, and ends with "Next" and "If something went wrong". Pages are in the present tense as released; only the roadmap page speaks of what is not built. Developer detail goes in the separate reference, not the guide. Delorun-owned prose uses British English.

## Delorun's documentation website

Delorun's documentation website is Delorun's own Fumadocs site in `delorun/apps/docs/`; its README, `delorun/apps/docs/README.md` with its Chinese pair, owns its routes, build, dead-link check and deployment. It reads each `delorun/docs/` pair, English at the root and Chinese under `/zh/`, publishes the user guide and references, and links upstream's documentation for harness topics instead of copying it. Each page names the Delorun version it describes and is also served as Markdown with `llms.txt` indexes; the site's README owns its routes, build and deployment. Upstream's `website/` and the [dsh-doc](../packages/preset/agent-preset/skills/dsh-doc/SKILL.md) website-publication workflow apply only to upstream's VitePress projection, which stays unmodified.

## Wordcount Budgets

[scripts/doc-budgets.manifest.json](../scripts/doc-budgets.manifest.json) sets standing-doc ceilings; `pnpm run verify-doc-budgets` rejects excess or missing files.

When the gate goes red:

1. **Relocate** content that belongs in another tier; leave a one-line link if needed.
2. **Condense** content that belongs here but can be shorter.
3. **Raise** the ceiling only when the words need the space; justify the manifest diff in the PR. A too-low ceiling is a budget bug.

Ceilings are guardrails, not reduction targets. At or below target, retain at least 5% headroom; above target, freeze the ceiling until relocation or condensation brings the document under target. Lower a ceiling only when the document still has room. Targets: root `AGENTS.md` ≤ 3,250; `architecture.md` and `delorun/docs/architecture/README.md` ≤ 2,400; subtree `AGENTS.md` ≤ 600, except `packages/AGENTS.md` ≤ 810 and this file ≤ 2,480; `packages/README.md` ≤ 994; plus `cordis-primer.md` 600, `testing.md` 1,300, `examples/AGENTS.md` 310. Review governs unbudgeted tiers.

## The slop checklist

Hunt these in any doc; [dsh-doc-writing](../.agents/skills/dsh-doc-writing/SKILL.md) runs this list as an audit:

- Duplicated rules: search a distinctive phrase; keep one home and link the rest.
- History outside its permitted tier: state current facts and link the historical owner.
- Implementation-status annotations in prose or diagrams ("implemented!", "future: …"). Status rots; the repo layout and package manifests carry it.
- Hand-restated catalogs, JSDoc, or inventories of tests, packages, and status when source or a generator is authoritative.
- Reasoning transcripts: step-by-step implementation narration, proof of obvious branches, test walkthroughs, or rejected local alternatives. Keep the resulting contract or durable rationale; delete the path used to derive it.
- Rationale repeated beside sibling methods instead of once at the owning capability or helper.
- Paragraph walls: one paragraph carrying several rules and parenthetical asides. Split it or demote the detail to its home.
- Emphasis inflation: bold, CAPS, or "critically" everywhere means nothing stands out. Reserve emphasis for the clause that changes behavior.
- Spec-speak in `implemented/` Agent Notes: "should", migration plans, acceptance checklists. An implemented Agent Note describes what is, per the [implemented-note instructions](../.agents/notes/implemented/AGENTS.md).

## Repository references

Use relative Markdown links for current files and tags or PR numbers for historical references. `verify-md-links` checks local targets. [Reference validation](../scripts/verify-repository-references.ts) rejects commit identifiers containing a hexadecimal letter and disallowed organization URLs in maintained files. Decimal-only tokens are ignored to avoid collisions with numeric data, even when they identify commits.
