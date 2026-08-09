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

## Scanner data provenance — what our own tools trust at runtime

*Added 2026-08-11, after the sign-off below. The dependency review asked what strape ships; it never asked what
strape's **scanners** fetch while deciding that. A scanner that silently loads third-party data at scan time is
part of the trust boundary — data that shapes a verdict is as load-bearing as code.*

| Tool | Fetches at run time | When | Trust note |
|---|---|---|---|
| `guarddog-scan` / `guarddog-metadata` | typosquat corpora from `hugovk.dev`, `packages.ecosyste.ms`, and **a mutable `latest` release tag** on `LeoDog896/npm-rank` | at **import** (`typosquatting.py:24-25`, in `__init__`), written into its own venv | the only **mutable, unpinned** input in the stack. Mitigated by accident, not design: local-path scanning runs source rules only, so this corpus cannot suppress a detection we would otherwise get. It could still *invent* a typosquat verdict. |
| `osv-scanner` | `api.osv.dev` | per scan | queried live, so results are not reproducible from the repo alone; a vulnerability appearing or being withdrawn changes the answer with no local change |
| `dep-health` | `api.deps.dev`, OpenSSF Scorecard | per run | Scorecard's `Maintained` scores trailing-90-day activity, so it **decays for any finished package**. Measured, not theoretical: jiti 5.5 → 4.5 with `Maintained` 9 → 1 and thirteen checks byte-identical. The gate reports this class rather than failing on it. |
| `socket-scan` | `api.socket.dev` | per run | needs `SOCKET_API_KEY`; gated on drift from a reviewed baseline, not on absolute alerts |
| `syft` (SBOM) | `toolbox-data.anchore.io` | per run | catalogue/metadata refresh |
| `npm audit signatures` | `tuf-repo-cdn.sigstore.dev` | per run | TUF root for registry signature verification |
| model catalog generator | `models.dev/api.json`, `integrate.api.nvidia.com`, `ai-gateway.vercel.sh` | only on `hydrate:model-data` | **closed 2026-08-11**: the catalog is now content-frozen by `model-catalog.mjs`, so this data can no longer move without a reviewed re-record. See HUNKS.md hunk 6. |
| `cosign` (release signing) | `fulcio.sigstore.dev`, `rekor.sigstore.dev`, `tuf-repo-cdn.sigstore.dev` | per release | added 2026-08-11; the signature is verified in-job against this workflow's own identity |

**Two general points.** First, every tool above is pinned by version *and* sha256 (`fetch-tool.mjs`,
`provision-tools.mjs`) — but pinning the **binary** says nothing about the **data** it pulls afterwards, and
the GuardDog corpus shows the two can diverge sharply. Second, Harden-Runner's block policy in
`strape-security.yml` is what makes this table enforceable rather than aspirational: an endpoint not listed
there cannot be reached, so a scanner growing a new data source fails loudly instead of silently widening
this boundary.

**Not fixed, recorded:** the GuardDog `latest`-tag fetch. Pinning it means forking GuardDog's fetch logic or
vendoring the corpus, both of which cost more than the residual risk in local-path mode.

## Addendum 2026-08-11 — items in this record that have since changed

The sign-off below stands for the tree as reviewed. Three statements above have been overtaken by later work,
noted here rather than edited in place, so the original review reads as what was true when it was signed:

- **The three `process-exec` false positives are fixed**, not merely recorded. `capability-sweep.mjs` now
  blanks regex-`.exec(` receivers before matching. This removed **27** false positives repo-wide (not 3 — the
  review counted only those in the changed files), taking `process-exec` from 115 sites to 88 and the total
  from 1692 to 1665. The 3 genuine `.exec(` sites — `operations.exec`, `ops.exec`, `env.exec` — are retained.
- **The capability baseline for this pin was itself wrong**, and the fix surfaced it. `--check` compared per-class
  *totals*, so a 1-for-1 substitution was invisible; switching it to compare `(class, file, text)` revealed that
  `capability-sweep-v0.84.1.json` had recorded the **vendor** text for `trust-manager.ts`'s lock call, missing
  hunk 16's `stale: 30_000`. The reviewed baseline did not match the reviewed tree. Both are corrected.
- **`verify-overlay.mjs` is now 29 invariants** (28 at sign-off), and the baselines regenerated for this pin now
  include **model-catalog** alongside capability-sweep, sbom, guarddog, dep-health and provenance.

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
