# @delo/plugin-instruction-consent

The instruction-layer consent: the service behind the seam that keeps a person's instruction-layer files — skills, presets, and a workspace's `AGENTS.md` — from being rewritten by a model's file tools without an approval that names the effect and shows the diff. Only upstream's file tools (`write`, `edit`, `apply_patch` and `str_replace_editor`) consult it, through the filesystem write, edit and delete intents: a shell command or a PTC script that the sandbox lets write the workspace changes an `AGENTS.md` or a project skill without asking. `@delo/bundle-local` mounts it on in the CLI profile that `delorun` starts; `delorun headless` and the desktop app run upstream's profiles, which do not mount it.


English | [中文](README.zh.md)
## What it provides

- `writeConsent` — consulted by the write tools before a model-authored file commits. A write whose target classifies as an instruction-layer file requires an approval whose text says these instructions load in every future chat of that scope and carries the diff, and carries `grants: "workspace-management"`, so a Host may keep the granting answer for its own computer (`@delo/home-auth` refuses it from a reach device); a refusal leaves the file unchanged.

The `sandboxModeGuard` of the session-mode seam is not this plugin's to provide: that seam keeps one provider, the full-access consent of [`@delo/plugin-permission-defaults`](../plugin-permission-defaults/README.md). A guard that refuses no switch would prove nothing the seam's own spec does not prove.

The service ignores the permission preset: the consent applies on every preset, full access included. A write the person makes in the studio's own editor asks nothing new — the seam sees writes through the model's file tools only.

The consent is a prompt for file-tool writes, not a boundary against a model that has a shell. It reviews every write the `fs/write-intent`, `fs/edit-intent` and `fs/delete-intent` waterfalls carry, which `write`, `edit` and `apply_patch` emit, and `str_replace_editor` too whenever `@deepseek-ai/dsh-tool-fs` is mounted beside it, because that package registers the gate on those intents. A shell command that writes an instruction file passes no such intent and no review.

## Classification

Every target and every root named below resolves to the real path of its nearest existing ancestor joined with the missing tail, which is the path `@deepseek-ai/dsh-fs-local` writes; a target whose last name is a symbolic link also resolves to the link's own location. A target matches a root when one of the target's existing ancestors is the root's existing part by device and inode, and the names from there down to the target begin with the root's missing tail. Identity covers symbolic links on either side, letter case and Unicode normalization of existing names, short names, and hard links; text compares only the missing tail and the name rules below. A path that is not absolute, as a remote backend may report, meets only the name rules, as spelled.

Text folds letter case when the existing directory that holds the target's or the root's first missing name sits on a case-insensitive volume. The probe takes the first entry of that directory whose name holds an ASCII letter and checks whether its case-flipped spelling names the same inode; a directory without such an entry counts as case-insensitive. Each consent instance remembers the answer per directory; the platform decides nothing.

The roots come from the code that reads them, on every review. A target classifies by the first rule it meets:

1. A skill: a path below `skills` in the harness home or the shared agent root (`HOME_SKILL_DIR` of `@deepseek-ai/dsh-skill-filesystem`), below any `.dsh/skills` or `.agents/skills` directory (`PROJECT_SKILL_DIRS`), or below a root the mounted skill providers report through `ctx.skills.configuredRoots()`, which holds the custom and bundled roots.
2. A preset: a composition file the profile launcher reads for `ctx.profileContext`, the order `readProfilePatches` applies: each selected bundle's declared patch files (from `loadProfileDirectory`), the profile's `cordis.patch.yml`, and the home's `cordis.patch.yml`. Without `ctx.profileContext`, no file classifies as a preset.
3. The home instructions: a file named in `DEFAULT_INSTRUCTION_FILE_NAMES` of `@deepseek-ai/dsh-agent-instructions` directly in the harness home or the shared agent root, or the file such a path resolves to.
4. A folder's instructions: any other file with one of those names.

The homes resolve from `DSH_HOME` and `DSH_AGENTS_HOME` when the review runs, and also as they resolved when the consent mounted, which is when the workspace instruction loader resolves its own; a skill provider row that configures other homes reports their skill stores through `configuredRoots()`. A target or root that fails to resolve for a reason other than absence, such as a link loop or a denied search permission, makes the review throw, and the seam refuses the write.

The review reads the filesystem when it runs, so a link created or swapped between the review and the write is not seen. The seam carries no workspace, so a write addressed directly to the directory a project's linked `.agents/skills` points at, or to the file a folder's linked `AGENTS.md` points at, or to a hard link of a folder's `AGENTS.md`, does not classify. Instruction file names a deployment adds through `instructionFileCandidates`, and `--patch` overlay files, do not classify either. Shell commands that write files are outside this review.

## Writes to an approved plugin's folder

With `approvedPluginWrites` on, the plugin also asks before the agent's first write in a chat to the folder of a plugin the person approved under Changes ([C21](../../docs/contracts/c21-changes.md#the-agent-and-plugins)): the `source` folder the profile's approval names, or the plugin's active directory under the Delo home. The ask says "The agent is changing what your harness runs: <plugin>. The change will wait for your review in Changes.", in English and Chinese, with the diff the tool carries. [`src/plugin-folders.ts`](src/plugin-folders.ts) reads the approvals from the profile the Host runs (`ctx.profileContext`) at every write, so a profile without the record has no plugin folders, and a record that cannot be read refuses the write. A target is inside a folder when its path resolved lexically is, or its real path is: the target's own, a dangling link's target, or the deepest existing ancestor's with the rest appended, so a symbolic link or a `..` spelling asks too. The listeners sit on the three filesystem intents every writer emits per target, prepended like the `writeConsent` gate. After the person allows it, later writes to that plugin's folders in the same chat pass until the Host restarts; another chat asks again, and a refusal leaves the file unchanged with the typed `FS_CONSENT_DENIED` refusal.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Delo's C16 switch `instruction_layer_consent`, off in the parity composition; on, the consent gates instruction-layer writes. |
| `approvedPluginWrites` | `false` | Delo's C16 switch `approved_plugin_write_consent`, off in the parity composition; on, the agent's first write in a chat to an approved plugin's folder asks. |

## Tests

`tests/consent.spec.ts` covers the classification rules, the review notes with the diff, the asked flow, resolution failures, and the switch. `tests/denial.spec.ts` covers writes through symbolic links, to hard links, in another letter case, and into a home resolved before the environment changed, each of which asks, and the case-sensitivity probe against the temporary directory's volume. `tests/loader-roots.spec.ts` runs the instruction loader's discovery, the filesystem skill provider and the profile launcher over a fixture and requires the consent to ask about every file they read. `tests/plugin-folders.spec.ts` runs upstream's `write` tool on the local filesystem: the first write to an approved plugin's folder asks and a second in the same chat does not, another chat asks again, a symbolic link, a `..` spelling, a relative path and the active directory ask, a refusal leaves the file unwritten, an unreadable record refuses, and with the switch off nothing asks.
