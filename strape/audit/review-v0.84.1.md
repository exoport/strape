# Source review — strape @ upstream pin v0.84.1 (diff mode)

Adopted 2026-08-09, from `v0.84.0 a5f43bf8a` to `v0.84.1 53fa77ccd`.

This is a **diff-mode** record. It does not restate the full-tree review at `review-v0.84.0.md`; it covers what
changed between the two tags and what that changed about strape. Read it alongside that file, not instead of it.

## Scope of the change

31 files in the reviewed scope, 1098 insertions / 235 deletions. Upstream's headline is an **auth preflight**
feature: `cli/auth-command.ts` and `cli/auth-check.ts` are new, `cli/credential-print.ts` was gutted to import
from them, and `core/auth-storage.ts` grew ~91 lines.

**Dependencies: no change to the shipped closure.** All 48 changed lines in `npm-shrinkwrap.json` are
`@earendil-works/*` internal version bumps `0.84.0 -> 0.84.1`. No external package was added, removed or
re-versioned, so every verdict in `reviewed-deps.json` carries forward unchanged and no new tarball needed
review. The closure is still 50 external packages / 56 SBOM components / 0 install scripts.

## Files touching security-critical paths

Upstream changed all seven tool implementations plus `core/extensions/types.ts`:
`tools/{bash,edit,find,grep,ls,read,write}.ts`. The changes are a uniform refactor threading an additional
context parameter through each tool's entry point — 7 to 20 lines each, no change to argument validation, path
handling or the spawn path. `core/extensions/types.ts` adds five lines of type surface.

## Capability drift: +45 sites, reviewed individually

Diffed by `(class, file, text)` rather than by class totals, because equal-size edits are invisible to a count.

| Sites | Where | Assessment |
|---|---|---|
| 38 | `cli/auth-command.ts`, `cli/auth-check.ts`, `core/auth-storage.ts`, `main.ts`, `cli/credential-print.ts`, `cli/args.ts` | the auth-preflight feature reading and handling credentials — expected for what it is |
| 4 | `packages/tui/src/tui-alt-screen.ts` | `env` reads for terminal capability detection |
| 1 | `core/auth-storage.ts:217` | `JSON.parse(readFileSync(this.authPath))` — parsing our own auth file |
| 1 | `packages/ai/src/providers/qwen-token-plan-individual.ts:10` | new provider, hardcoded Aliyun `baseUrl`; out of strape's provider scope and matched by no `enabledModels` pattern |

**Three of the reported `process-exec` sites are false positives.** `auth-command.ts:76`, `auth-command.ts:125`
and `packages/tui/src/latex.ts:887` are all `RegExp.prototype.exec`, not `child_process.exec`. The sweep matches
`.exec(` without regard to the receiver, so it over-reports this class. Recorded as a precision limitation of
`capability-sweep.mjs`, not as a finding about upstream.

## What the merge did to strape's hunks

Five conflicts. Resolutions:

| File | Resolution |
|---|---|
| `main.ts` | import-list conflict only; hunks 7 and 12 survived the auto-merge (`:598`, `:675`) and were verified present |
| `packages/ai/package.json` | hunk 4 held — the five provider SDKs stay in `devDependencies`; took upstream's `pi-telemetry ^0.84.1` |
| `cli/credential-print.ts` | took upstream's rewrite wholesale; the strings hunk 3 owned moved to a new file (below) |
| `npm-shrinkwrap.json`, `install-lock/package-lock.json` | **regenerated, not inherited** |

The shrinkwrap point is the one to remember. Taking upstream's side reintroduced `@google/genai` and
`protobufjs` **with install scripts**, and `verify-overlay` failed on it immediately. Generated files must be
regenerated from strape's manifests after every merge; inheriting them silently undoes hunk 4.

### Hunk 3 regression caught by the gate

Upstream split the auth CLI out of `credential-print.ts` into a **new** `cli/auth-command.ts`, re-hardcoding
`pi auth` in seven places. A new file cannot conflict, so the merge was silent and the rebrand would have been
lost. The hunk-3 invariant failed and named the file. The rebrand was re-applied there (`${APP_NAME}` template
literals, importing `APP_NAME` from `../config.ts`) and the invariant re-anchored from `credential-print.ts` to
`auth-command.ts`.

This is the second time a rebrand gap has arrived in a file that did not previously exist. The lesson for the
next sync is unchanged: an invariant anchored to a *file* only protects that file.

## Accepted issue: the vendored model catalog tracks live third-party data

Upstream's new provider ships no vendored model data, so `build:offline` failed until the catalog was
re-hydrated. Re-hydrating pulls **models.dev as of today**, not as of the adopted tag, and today's data changes
the API shape of `opencode` models. That breaks a type assumption in an upstream test:

```
packages/ai/test/openai-completions-tool-choice.test.ts(1410,25):
  error TS2339: Property 'maxTokensField' does not exist on type
  'OpenAICompletionsCompat | OpenAIResponsesCompat'
```

**This is not strape-specific.** Upstream `.gitignore:11` excludes `packages/ai/src/providers/data/` — upstream
generates that data live at every build, so anyone building `v0.84.1` against current models.dev gets the same
error. Hunk 6 vendors the directory so strape can build offline; the effect is that it makes upstream's drift
visible rather than causing it.

**Accepted for this pin.** `npm run build:offline` passes, `check:model-data` passes, and CI is unaffected
(`strape-build.yml` runs `check:pinned-deps`, `check:shrinkwrap` and `check:install-lock`, not `npm run check`).
The single failing check is `tsgo --noEmit` over an upstream **test** file.

Rejected alternative: trimming the catalog to strape's provider scope. `providers/all.ts` statically imports
41 providers and the generator has no provider filter, so trimming data requires editing a file upstream
modifies every release — a permanent merge cost to suppress a temporary upstream defect.

Backlog instead: **freeze the catalog** — stop re-hydrating wholesale at sync time and add only newly required
provider files, which needs a strape-owned script to regenerate `.manifest.json` from the files present. That
removes the drift class with zero divergence. Re-check on the next sync whether upstream has realigned.

## Verification

- `verify-overlay.mjs` — 28 invariants
- `reviewed-deps.mjs` — 50/50 allowed, closure unchanged
- `lockfile-audit.mjs`, `check:model-data`, `check:shrinkwrap`, `check:install-lock` — pass
- `npm run build:offline` — passes
- regression tests — redirect guard 6, jiti cache 4, mermaid throw 3, trust 11, agent-dir 11, rebrand 6, compat 6
- baselines regenerated for this pin: capability-sweep, sbom, guarddog, dep-health, provenance

## Sign-off

An agent review is evidence, not sign-off. `review-attest --record` binds a named human to the digest of the
reviewed scope; until that is run for this pin, `--verify` fails and the release gate is closed.

```
Upstream pin adopted:      v0.84.1 53fa77ccd8a279eb87e92294ef3687b03ff80112
Previous pin:              v0.84.0 a5f43bf8aff3c55752432655f7334e3dafd1e256
Closure:                   50 external packages, unchanged from v0.84.0
Review performed by:       Claude Opus 5 agents (claude-opus-5[1m]), diff mode
Report date:               2026-08-09

Human reviewer name:       ______________________________________
Human reviewer date:       ______________________________________
```
