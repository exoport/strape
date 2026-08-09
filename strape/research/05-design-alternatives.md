# Design Alternatives: The Decision Record

This file answers: what were the two competing fork designs considered for strape, how did each hold up on
its own terms, what specific factual conflicts arose between them (and between them and the earlier
research), how were those conflicts resolved with evidence, and what was ultimately built vs. rejected.
Evidence is drawn from `05-design-minimal-effort.json` ("Design A"), `06-design-security-first.json`
("Design B"), and `07-synthesis-recommendation.json` (the resolution), cross-checked against the actual
`strape-proposal.md` and the implemented `strape/` repo's `git log`/`git diff` and
`strape/docs/HUNKS.md`. Every claim below that was empirically tested by a design pass is marked as such;
several were tested by *running commands against the live repo and reverting*, which this file treats as
"verified by running a command," not merely asserted.

## 1. Design A: Additive Overlay Fork (build-time codemod)

**Shape.** A git fork whose branch diff against any upstream tag consists **only of added files**.
Branding, provider restriction, and dependency trimming are not committed as source edits; instead,
`strape/apply.mjs` — a small, idempotent codemod with assert-exactly-once guards on every anchor string —
applies them to the working tree immediately before a build and reverts them with `git checkout -- .`
immediately after. The working tree is therefore pristine upstream at rest, and dirty only transiently
during a build.

**Why this shape was chosen for consideration**: `git merge v0.NN.0` is conflict-free *by construction*,
since strape never touches an upstream-owned line at rest.

**Verified claims from this design pass** (run live in the clone, then reverted, repo left clean):

1. Setting `piConfig: {name: "strape", configDir: ".strape"}` + `bin: {strape: ...}` and rebuilding produces
   a fully rebranded `--help` output (`strape - AI coding assistant...`, `strape install/update/config`,
   `STRAPE_CODING_AGENT_DIR - Config directory (default: ~/.strape/agent)`) with only **two** residual "pi"
   strings in the entire ~180-line help output.
2. Moving five unused-provider SDKs from `dependencies` to `devDependencies` in `packages/ai/package.json`
   shrinks the shipped closure from **143 to 56 packages**, and install-script packages from **2 to 0**,
   measured with upstream's own `scripts/generate-coding-agent-shrinkwrap.mjs`.
3. That trim *requires* also emptying `allowedInstallScriptPackages` in both generator scripts — verified
   by observing the generator hard-fail with "allowed install-script package @google/genai@1.52.0 is no
   longer present" otherwise.
4. **A premise correction to the earlier research**: the heavy provider SDKs are **not** loaded at startup
   — `packages/ai/src/api/*.lazy.ts` wraps them in `lazyApi(() => import(...))`, so trimming them is safe
   and only fails if an Anthropic/Bedrock/Google/Mistral model is actually invoked.

**Pros** (as argued by this design): merge conflicts are structurally impossible, not merely unlikely;
the dependency win is large and cheap; upstream drift fails loudly via anchor-count assertions and a daily
drift canary; nothing upstream-facing (checked-in shrinkwrap, lockfile, `npm run check`) is ever disturbed
at rest.

**Cons** (as argued by this design, and as later weighed against Design B): the build is not
`npm run build` — it's `node strape/build.mjs`, and hand-editing upstream files in the checkout is
disallowed by the tooling; transforms are **string-anchored**, so an upstream rewording of the system
prompt or a refactor of `builtinProviders()` breaks the build until `apply.mjs` is updated — the *same*
failure mode a merge conflict would produce, but arrived at via a different, more mechanically complex
path; `grok-mermaid` cannot be trimmed the same cheap way (static import in the TUI); renaming the npm
package name breaks `strape update --self` and disables `isOfficialDistribution()`'s first-run wizard —
accepted as fine by this design, but a real behavior delta.

## 2. Design B: Audited Vendor Fork (pristine mirror + `strape/` overlay)

**Shape.** A git fork where the tree stays byte-identical to a reviewed upstream tag except for a small,
fixed number of **committed** hunks in upstream-owned files, plus one new top-level `strape/` directory
(new files never merge-conflict). Two branches: `vendor` (pristine, hard-reset to release tags, never
edited) and `main` (`vendor` + hunks + `strape/`). A two-stage gate — Stage A (sync: source-diff +
lockfile-diff + audit + osv + SBOM review of a specific upstream tag, network allowed) and Stage B
(build/deploy: `npm ci --ignore-scripts --offline` from a warmed cache, air-gapped) — is the organizing
principle.

**Verified claims from this design pass** (also run live, reverted):

1. Same premise correction as Design A, but backed by running upstream's own test: "upstream's own
   `packages/ai/test/lazy-module-load.test.ts` asserts that importing the root barrel, building all
   builtin providers, and calling `getModels()` load ZERO provider SDKs. I ran it: 5/5 passing." This is a
   stronger form of evidence than Design A's assertion of the same fact — Design A pointed at the `.lazy.ts`
   wrapper files; Design B additionally executed upstream's own regression test proving the property holds.
2. Trimming the root `workspaces` array to drop the five example-extension workspaces does **not** require
   regenerating `package-lock.json` — verified: `npm ci --ignore-scripts --offline` with the trimmed array
   and the *untouched* lockfile succeeds (319 packages vs. 339 baseline, no warnings), and `ssh2`/
   `cpu-features` never land on disk.
3. `packages/ai/src/providers/data/` (the gitignored, network-hydrated model catalog) can be vendored into
   git: `npm run hydrate:model-data` succeeded (39 files, 600K), then `npm run build:offline` succeeded
   end-to-end with zero network calls, and the built CLI correctly listed Grok/GPT models under
   `PI_OFFLINE=1`.

**Pros** (as argued by this design): every shipped byte is traceable to a reviewed, tag-pinned source tree;
zero-divergence provider hardening is possible via a `node --import` module denylist that blocks SDK
*resolution* rather than deleting dependencies (proposed as optional belt-and-braces, not primary control,
in the final design); the biggest single dev-surface cut costs zero lockfile churn; the merge surface is
tiny and structurally stable (a handful of hunks in files upstream rarely rewrites).

**Cons** (as argued by this design): real recurring lag — deliberately not tracking head means sitting
1-4 weeks behind; vendored model data goes stale between syncs; upstream contributions are effectively
impossible given the `lgtm` gate (see `strape/research/04-upstream-health-and-licensing.md` §3), so the hunks are
carried forever; `grok-mermaid` still cannot be denylisted (static import).

## 3. Conflicts between the two designs, and how each was resolved

### 3.1 Dependency trim vs. runtime denylist — **trim wins**

Design B's initial framing (echoing the very first compat/provider research pass) was that because provider
SDKs are lazily loaded, deleting them from `dependencies` is "pure divergence with no runtime-surface
benefit," and proposed a `node:module` `registerHooks`-based denylist as the primary control instead — block
*execution* of the denied modules, leave them on disk.

**07-synthesis-recommendation.json's resolution: "Half right."** Lazy loading does mean no startup
execution — that part of Design B's premise correction was accurate and valuable. But 87 extra packages
still land on disk and in the review surface either way, and critically, `protobufjs`'s install script
still ships and still executes during `npm install` regardless of whether the code that *uses* protobufjs
is ever imported at runtime. A runtime denylist governs what code can execute after install; it does
nothing about what an install script does *during* install, and nothing about what a human reviewer has to
read. The synthesis re-ran upstream's own generator and confirmed the same 143 → 56 / 2 → 0 numbers,
concluding: **the trim is strictly the higher-leverage control, and the denylist is worth keeping only as
optional belt-and-braces on top of it, not as a replacement for it.** This is exactly what shipped: hunk 4
(the dependency-section trim) is one of the six committed hunks; the `node --import` denylist described in
Design B's `strape/runtime/deny-modules.mjs` was kept as an **optional** add-on (present in the repo at
`strape/runtime/deny-modules.mjs`, confirmed in this pass) rather than the primary security mechanism.

### 3.2 "Trimming forces lockfile regeneration" — **disproved**

An implicit worry running through the earlier research (that removing dependencies from `package.json`
necessarily means `npm install` will re-resolve the tree, potentially floating transitive versions and
undoing the careful pinning regime) was tested directly and disproved by **both** design passes
independently: `npm ci --ignore-scripts --dry-run` succeeds against the **untouched** `package-lock.json`
with the dependency-section trim (and, separately, the workspaces trim) applied. Design A measured 319
packages with the trim vs. 339 baseline; Design B's independent run reported the same qualitative result at
its own tested scope. Because `npm ci` (unlike `npm install`) refuses to modify the lockfile and simply
installs exactly what the lockfile specifies, moving a dependency from one section of `package.json` to
another (`dependencies` → `devDependencies`) doesn't touch what versions are pinned — it only changes
which subset of the *already-resolved* tree is installed under `--omit=dev`. This is why the trim is a
5-line, effectively free, permanently repeatable change rather than a one-time act that would need
re-justifying on every sync.

### 3.3 The build-time codemod (Design A's core mechanism) — **rejected**

The final synthesis rejected Design A's central mechanism, not its findings. Reasoning, verbatim from the
resolution: the codemod "trades 5 stable committed hunks for ~180 lines of string-anchor machinery with the
same failure mode (upstream rewording) plus a dirty-tree build ritual." In other words, both designs face
the identical risk — an upstream rewording breaks the automation — but Design A pays for avoiding merge
conflicts with a second, parallel piece of custom tooling (`apply.mjs`) that has to be maintained, tested,
and kept in sync with the six-hunk `verify-overlay.mjs` invariants anyway. Design B's committed-hunk
approach gets the same "loud, early failure on drift" property (via `verify-overlay.mjs` and a daily
drift-canary CI job) with less machinery, because git's own merge conflict *is* the failure signal, rather
than a custom string-count assertion. Design A's genuinely good ideas — assert-exactly-once anchor checks,
a `reviewed-deps.json` gate, a daily drift canary — were folded into the winning design rather than
discarded. `strape-proposal.md` §3.4 records this explicitly: "More code, same failure mode, worse
ergonomics. Its good ideas... are kept here."

### 3.4 Why a wrapper-only, no-fork approach is impossible

Both designs independently arrived at, and the synthesis confirmed, the same hard blocker: a thin npm
wrapper package that merely `require()`s or execs `pi-coding-agent`'s `dist/cli.js` **cannot** rebrand the
CLI, because `APP_NAME`, `CONFIG_DIR_NAME`, and `bin` are all read from the `pi-coding-agent` package's
**own** `package.json` (`config.ts:487-496`), via `getPackageDir()` (`config.ts:367-388`), which walks up
from that specific module's own `__dirname` (or `dirname(process.execPath)` for the Bun binary) — not from
the invoking script's directory, and not from any wrapper's `package.json`. The only override,
`PI_PACKAGE_DIR` (`config.ts:369`), is meant for Nix/Guix store-path issues and would require the wrapper to
reproduce the *entire* `dist/` asset tree (themes, docs, examples, README, CHANGELOG) to be usable — at
which point it is no longer a thin wrapper, it *is* a fork. No `settings.json` field or environment
variable exists as an alternative lever; `config.ts:491` is the sole definition of `CONFIG_DIR_NAME`, and a
repo-wide grep found no context-file-naming setting either. **This is why "fork, minimally" was never
actually in competition with "don't fork" — the latter option does not exist for a real rename**, only for
the Claude-compat and provider-restriction goals (which genuinely are achievable via pure configuration, per
`strape/research/02-claude-compat-and-providers.md`).

## 4. The chosen hybrid

`07-synthesis-recommendation.json` names the outcome explicitly: **"Audited Vendor Fork (hybrid, Design
B's shape + Design A's dependency trim)."** Concretely:

- Design B's shape: two branches (`vendor` pristine, `main` = vendor + hunks), merge-never-rebase,
  `verify-overlay.mjs` as the CI/pre-commit invariant checker, a staged review-then-build sync process.
- Design A's dependency trim as the primary security control (§3.1 above), not Design B's denylist-first
  framing — the denylist survives only as an optional add-on.
- Design A's build/CI hygiene ideas (anchor assertions, `reviewed-deps.json` gate, drift canary) folded into
  Design B's committed-hunk mechanics rather than kept as separate codemod machinery.

This produced **six committed hunks** in the shipped repo (`strape/docs/HUNKS.md`, confirmed via
`git diff v0.84.0..main --stat` in this pass, 47 files changed / 53 insertions / 24 deletions total):

| # | File(s) | Change |
|---|---|---|
| 1 | `packages/coding-agent/package.json` | `piConfig.name/configDir` + `bin` — the rebrand seam |
| 2 | root `package.json` | drop 5 example-extension workspaces |
| 3 | `packages/coding-agent/src/core/system-prompt.ts` | the two un-parameterized identity strings |
| 4 | `packages/ai/package.json` | move 5 provider SDKs `dependencies` → `devDependencies` |
| 5 | `scripts/generate-coding-agent-{shrinkwrap,install-lock}.mjs` | empty `allowedInstallScriptPackages` |
| 6 | `.gitignore` + `packages/ai/src/providers/data/` | delete the gitignore line, commit the vendored model catalog |

(The proposal's narrative text sometimes refers to "5 hunks" when discussing the initial design and "6
hunks" once the vendored-model-data hunk is folded in explicitly; `strape/docs/HUNKS.md`, the authoritative
as-built record, lists six, and this is the number actually implemented and confirmed by `git log`: three
commits — `7d711d0f6` hunks 1&3, `fac9677ee` hunks 2,4,5, `2ec7fb128` hunk 6 — sit directly on top of the
`Release v0.84.0` tag commit.)

## 5. Rejected alternatives (final list)

| Alternative | Why rejected |
|---|---|
| Thin wrapper npm package, no fork | Impossible for the rename goal — see §3.4. `APP_NAME`/`CONFIG_DIR_NAME`/`bin` are sourced from the coding-agent package's own `package.json`, with no settings/env override. |
| Build-time codemod overlay (Design A's core mechanism) | Same failure mode as a merge conflict (upstream rewording breaks it) but with more custom machinery and a dirty-tree build ritual to maintain; its good ideas were kept, its mechanism was not. |
| Patch queue / rebase fork | Upstream bumps `version` (line 3) directly next to `piConfig` (lines 6-8) in the same file on every release, guaranteeing near-constant trivial-but-recurring conflicts; rebasing re-resolves the same conflicts repeatedly instead of resolving once via merge. |
| Runtime module denylist *instead of* dependency trimming | Blocks execution but leaves the packages on disk and in the review/audit surface, and does not stop an install script (`protobufjs`) from running during install. Demoted to an optional, secondary control. |
| Renaming the npm scope (`@earendil-works/pi-*` → strape) | ~469 files reference it; zero value for a fork that never publishes to the public registry; would create a permanent, ever-growing conflict surface for no benefit. `piConfig.name` alone already flips `isOfficialDistribution()` false. |
| Deleting `packages/{server,client,protocol,evals}` / sqlite-node | Unnecessary: `pi-client`/`pi-protocol` are real, already-minimal CLI dependencies that ship in the trimmed 56-package closure regardless; `pi-server`/sqlite-node already never shipped. Deleting them would need a seventh hunk patching `build:offline`'s package list, for no measurable security gain — declared out of *review* scope instead of out of the build. |
| A fully air-gapped, hash-verified distribution artifact from day one | Deferred as an escalation path, not built initially — the existing controls (exact pins, integrity-hashed shrinkwrap, `--ignore-scripts`, daily audit+signatures) already cover the highest-value, lowest-effort wins; reserve the extra plumbing for if/when an air-gapped requirement actually appears. |
| Reordering the `CLAUDE.md`/`AGENTS.md` context-file precedence (a candidate "seventh hunk") | One line, technically easy, but rejected for now: cheaper to simply not keep both `AGENTS.md` and `CLAUDE.md` in the same directory than to carry a permanent hunk for it. Recorded in `strape/docs/HUNKS.md` as revisitable, not closed forever. |
