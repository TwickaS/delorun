# Agent Note: Delo's documentation is English and Chinese, with a consistency record per page

Status: implemented

English | [中文](2026-11-06-delo-bilingual-documentation.zh.md)

## Problem

Delo's documentation is read by people and agents in English and in Chinese. A page that exists in one language only leaves readers of the other without its facts, and a translation that drifts from its source gives each reader different facts. The upstream pairing contract already defines how a page and its counterpart stay consistent. Delo's documentation needs the same guarantee, and its terms must mean the same thing on every page.

## Decision

Every page under `delo/docs/` is an English and Chinese pair with its consistency record, under the [upstream bilingual contract](../../../../docs/i18n/README.md). The pairing gate covers `delo/docs/`. Delo's documentation is English and Chinese only. Delo's interface screens ship in every upstream UI language, which is a separate matter from the documentation.

Delo's product terms and their Chinese renderings are in the [terminology source](../../../../docs/i18n/terminology.md), and Delo's glossary gives each concept its entry. Translations use the renderings in the terminology source.

The documentation standard requires the Delo documentation website to serve each page as Markdown as well as HTML, with an `llms.txt` index for coding agents, and each page to name the Delo version that it describes.

## Verification

`pnpm run verify-translation-pairing` checks each pair's consistency record, its language switcher and its structure, over `delo/docs/` and upstream's scope. The documentation gates `pnpm run verify-md-wrap`, `pnpm run verify-md-links`, `pnpm run doc-typecheck` and `pnpm run verify-doc-budgets` check the same pages. A passing gate confirms structure and recorded hashes, and review confirms that the two languages say the same thing.

## Related

The archived [section-keyed pairing records decision](../../archived/process/2026-09-23-section-keyed-translation-pairing-records.md) records the format of the consistency records. It is frozen, and this note uses the format as the current bilingual contract states it.

## Alternatives considered

**English only.** Readers of Chinese would lack the same facts, and the documentation would not serve the people it is written for.

**More languages.** Each added language adds a full pair for every page and a review by a reader of that language. Delo's reviewers read English and Chinese, so a third language would be translated without a reviewer who could check it.

## Consequences

Each documentation change updates both languages in the same change, and the reviewer checks meaning as well as structure.

Each page's consistency record is part of its change, so a page edit that does not re-record its pair fails the gate.

The website publishes two languages and a Markdown copy of each page, so each page has more than one published form to keep correct.
