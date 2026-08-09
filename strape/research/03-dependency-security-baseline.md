# Dependency and Supply-Chain Security Baseline

This file answers: what supply-chain controls does pi already have, what does each one actually guarantee
(and not guarantee), what measurable effect did strape's dependency trim have, and what residual risk
classes remain that no scanner catches. Evidence is drawn from `03-dependency-security.json` (a hands-on
audit that ran real `npm ci`, `npm audit`, and `npm audit signatures` commands against the live repo — the
report explicitly flags which findings are "verified by running a command" vs. "verified by reading
source"), cross-checked against `05-design-minimal-effort.json` and `06-design-security-first.json` (which
independently re-ran the shrinkwrap generator against a trimmed manifest), and re-verified in this pass
directly against the implemented `strape/` repo's generated `npm-shrinkwrap.json`, `strape/audit/*.json`
files, and `git diff` output.

## 1. Inherited controls and exactly what each guarantees

| Control | Where | What it actually guarantees | What it does *not* guarantee |
|---|---|---|---|
| Exact pins on direct deps | `scripts/check-pinned-deps.mjs` (`npm run check`) | Every external dep (non-`@earendil-works/pi-*`, non-workspace/git/file/http) in every `package.json`'s `dependencies`/`devDependencies`/`optionalDependencies` is an exact `X.Y.Z`, enforced by regex, no `^`/`~`/ranges | Nothing about transitive pinning — that's `package-lock.json`'s job; does not verify integrity/signatures itself |
| `.npmrc`: `save-exact=true`, `min-release-age=2` | `pi/.npmrc:1-2` | Forces exact pins on every `npm install <pkg>`; **verified live in this environment** by running `npm config list`, which showed npm 11.12.1 dynamically translating `min-release-age=2` into a real `before` cutoff (`before=2026-08-05T00:16:38.268Z` when "now" was `2026-08-07T00:16:38Z`, to the second) — i.e. npm's resolver actively refuses any dependency version published within the last 2 days, a real mitigation against fast-propagating worm-style npm account-takeover attacks | Does nothing against a slow-burn attack (a malicious version that looks fine for 2+ days); no forcing function re-reviews a dependency after the 2-day window passes |
| Integrity-pinned generated shrinkwrap | `scripts/generate-coding-agent-shrinkwrap.mjs` → `packages/coding-agent/npm-shrinkwrap.json` | Computes the CLI's full transitive closure from `package.json` graphs + the root lockfile (no `node_modules` needed); writes resolved tarball URLs + sha512 integrity per package; is honored by npm when *consumers* run `npm install @earendil-works/pi-coding-agent` (unlike `package-lock.json`, `npm-shrinkwrap.json` binds end-user installs, not just contributors) | Only as good as its allowlist review (see next row) — a compromised republish under the same version+script name would be caught by an integrity-hash mismatch, but the generator does not diff script *contents*, only allowlist membership |
| Install-script allowlist + stale-allowlist detection | same script, hard-coded `allowedInstallScriptPackages` map + validator | Fails the build if **any** package in the resolved tree has `hasInstallScript=true` and is not in the (originally 2-entry) allowlist; also fails if a previously-allowlisted package disappears from the tree (stale-allowlist detection) | Does not itself vet whether a script is actually harmless — that's a one-time human judgment call recorded as a comment |
| `overrides` (protobufjs, rimraf) | root `package.json:65-70`, duplicated in `coding-agent/package.json:68-73` | Pins exact versions across the whole graph even where a dependent requests a looser range (e.g., a package requesting `protobufjs ^7.5.4`) — prevents a transitive floating range from silently resolving to an unreviewed version | Only covers the specific packages listed; does not generalize |
| `--ignore-scripts` on every install | CI workflows, `.npmrc` context, documented practice | Verified functionally safe by actually running it: a real `npm ci --ignore-scripts --no-audit --no-fund` (339 packages, ~9s) followed by `node node_modules/esbuild/bin/esbuild --version` succeeded, because esbuild's platform binary ships via an `optionalDependency`, not the skipped postinstall; the two allowlisted prod packages with install scripts (`@google/genai`'s preinstall, `protobufjs`'s postinstall) were independently read and confirmed to be a no-op echo and a version-mismatch warning respectively | Does not protect against a *new* dependency that secretly needs its postinstall to function — this must be smoke-tested per addition (a recommendation, not an existing control) |
| Pre-commit lockfile-diff gate | `.husky/pre-commit` → `scripts/check-lockfile-commit.mjs` | Blocks any commit that stages a `package-lock.json` diff touching `node_modules/*` entries, printing every added/removed/changed package, unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set | Only fires on local commits; does not by itself cover a `git merge` from upstream (strape adapts the same diff logic for upstream-sync review instead — see `strape/research/05-design-alternatives.md`) |
| SHA-pinned GitHub Actions | `.github/workflows/*.yml` | `actions/checkout`/`actions/setup-node` pinned to full commit SHAs (with a version comment), not mutable tags, in both `ci.yml` and `npm-audit.yml` | — |
| Daily `npm audit` + `npm audit signatures` | `.github/workflows/npm-audit.yml`, cron `37 7 * * *` | `npm ci --ignore-scripts` → `npm audit --omit=dev --audit-level=moderate` → `npm audit signatures --omit=dev`. **Verified live in this environment** (network was available): `npm audit --package-lock-only --omit=dev` returned 0 vulnerabilities; a real install's `npm audit signatures` reported all 324 audited packages had verified registry signatures, and 66 had verified npm provenance/sigstore attestations | `npm audit` only catches *known*, published CVEs — it has no opinion on a young/unreviewed/single-maintainer package with no CVE (see §3). Note also: `npm audit signatures` **requires a real `node_modules`** — the `--package-lock-only` mode used for the CVE check cannot verify signatures/provenance at all; a lockfile-only pipeline silently loses that coverage unless it also runs a real install, which upstream's own workflow correctly does |
| `npm publish --provenance` | `scripts/publish.mjs`: `npm publish --access public --provenance --ignore-scripts` | Attaches provenance attestations to published releases | Only applies if strape ever publishes to the public registry, which it explicitly does not (local `local-release.mjs`-based tarball distribution instead) |
| No Dependabot/Renovate | (absence confirmed by grep, no config found anywhere) | Dependency bumps are manual/reviewed only, consistent with the stated policy "treat npm dependency changes as reviewed code changes" | No automatic freshness/security-bump forcing function exists at all upstream |

## 2. The measured effect of strape's trim

### 2.1 The headline numbers

Moving five provider SDKs (`@anthropic-ai/sdk`, `@aws-sdk/client-bedrock-runtime`,
`@smithy/node-http-handler`, `@google/genai`, `@mistralai/mistralai`) from `dependencies` to
`devDependencies` in `packages/ai/package.json`, and emptying the `allowedInstallScriptPackages` map in
both generator scripts, was **measured, not estimated**, by running upstream's own
`scripts/generate-coding-agent-shrinkwrap.mjs` against the modified manifest:

| | Before (upstream v0.84.0 baseline) | After (strape) |
|---|---|---|
| Shipped production packages | 143 | 56 |
| Install-script packages | 2 (`@google/genai@1.52.0`, `protobufjs@7.6.5`) | 0 |

This exact result was independently reproduced by both competing design passes
(05-design-minimal-effort.json: "Wrote packages/coding-agent/npm-shrinkwrap.json (56 packages, 10
platform-specific)... zero `hasInstallScript` entries"; 06-design-security-first.json's `security_posture`
section states the identical numbers) and is confirmed present in the actual implemented repo in this pass:
`packages/coding-agent/npm-shrinkwrap.json` currently has **57** entries (56 shipped packages + the
coding-agent package itself — the same "+1 for itself" convention the pre-trim 143-count used, per
03-dependency-security.json key_facts #5: "143 packages (142 unique + itself)"), and `hasInstallScript`
is an empty array. `strape/audit/sbom-v0.84.0.json` independently lists exactly **56** components.

56 minus 10 platform-specific `@mariozechner/clipboard-*` binaries means roughly 46-47 packages actually
land on any one machine's `node_modules` — small enough, per the proposal's framing, "that a human can
genuinely read end-to-end."

### 2.2 What specifically left the closure

The trim removed: the entire `@aws-sdk`/`@smithy` tree, `@google/genai` (and its preinstall) +
`protobufjs` (and its postinstall), `@anthropic-ai/sdk`, `@mistralai/mistralai`, plus their shared
transitive dependencies `google-auth-library`, `jws`, `ws`, and `long` (strape-proposal.md §3.3, §7.1).

A separate, zero-cost cut (root `package.json`'s `workspaces` array, dropping the five
`packages/coding-agent/examples/extensions/*` entries) removes `ssh2` and `cpu-features` — both native,
node-gyp-compiled packages — from the **dev** install graph entirely. This was never in the shipped closure
to begin with (they were pulled in only by the `gondolin` example-extension workspace,
03-dependency-security.json key_facts #23 and risks #1), so this cut reduces dev/build supply-chain
surface, not the shipped-product surface.

### 2.3 Why this trim was judged safe (and the disagreement it resolves)

The trim is safe from a startup-execution standpoint because pi lazily imports provider SDKs
(`packages/ai/src/providers/anthropic.ts:1` → `../api/anthropic-messages.lazy.ts`; upstream's own
`packages/ai/test/lazy-module-load.test.ts` asserts zero SDK loads on barrel import +
`builtinProviders()` + `getModels()`, independently run and confirmed passing 5/5 by
06-design-security-first.json). **This is precisely why the disk-presence vs. execution-surface
distinction matters** — see `strape/research/05-design-alternatives.md` for the full "trim vs. runtime denylist"
argument this resolved. The short version: lazy loading means removing the dependency doesn't break
anything at import time, but its *presence on disk* was never a runtime-execution risk in the first place —
the risk it removes is install-footprint, review-burden, and (for `protobufjs`) an install-script attack
surface, which a runtime denylist alone cannot address.

**Verified independently to require no lockfile regeneration**: `npm ci --ignore-scripts --dry-run`
succeeds against upstream's *untouched* `package-lock.json` with the trim applied (05-design-minimal-effort
and 06-design-security-first both verified this, at slightly different package counts — 319 vs. 339
baseline packages — because they measured different scopes of the trim, i.e. with vs. without the
workspaces cut applied simultaneously). This is the single most important disproved claim carried forward
from the design debate: an earlier concern (05-design-minimal-effort.json's own initial framing, later
corrected within the same report) was that dependency trims might force a lockfile regeneration, which
would reintroduce exactly the kind of "did a transitive version silently float" risk the whole pinning
regime exists to prevent. It does not.

## 3. Residual risk classes no scanner catches

`SECURITY.md` explicitly scopes dependency reports **out** of upstream's bug-bounty process unless the
report shows a shipped dependency is affected *and* reachable through pi (`SECURITY.md:85-86`) — meaning
strape cannot rely on upstream's process to surface dependency risk in packages it doesn't directly
control, and none of the controls in §1 (exact pins, shrinkwrap, `--ignore-scripts`, daily audit +
signatures) catch the risk class below, because it has no known CVE, no install script, and a valid
registry signature.

`strape/audit/high-scrutiny.json` (re-verified in this pass) records four entries, tiered, none yet signed
off by a human (`reviewedBy`/`reviewedAt` are `null` for all four — see §4):

| Package | Version | Tier | Why it's high-scrutiny | Escalation if review raises doubt |
|---|---|---|---|---|
| `grok-mermaid` | 0.2.2 | A | Created 2026-07-28, single maintainer, ~1.2k downloads/month, **direct production dependency of the CLI**, statically imported by the interactive TUI (`packages/coding-agent/src/modes/interactive/components/mermaid.ts`) — so it **cannot** be covered by a runtime module denylist without breaking interactive mode | Vendor into `strape/vendor/grok-mermaid` with a root `overrides` `file:` entry (costs one lockfile regeneration), or drop mermaid rendering from the TUI |
| `proper-lockfile` | 4.1.2 | A | Unpublished since 2022-06-24 — abandoned upstream despite ~84M downloads/month; an abandoned package with a live npm publish right is a standing account-takeover risk, and it performs filesystem locking on paths strape cares about (session/auth files) | Replace with Node's `fs` primitives + atomic temp+rename; consider vendoring if the account is ever flagged |
| `@silvia-odwyer/photon-node` | 0.3.4 | C | Single maintainer, ships WASM — the payload cannot be meaningfully read; used for image processing of attachments; review basis is provenance + capability scan + pinning, not a source read | If image-attachment support isn't needed for the Grok/OpenAI workflow, removing the feature removes the dependency entirely |
| `@mariozechner/clipboard` | 0.3.9 | C | Loads a prebuilt native `.node` binary (10 platform-specific sibling packages, all in the shipped closure); native code is unreadable in review; it is also the **only native module left** after the workspace trim removed `ssh2`/`cpu-features` | Platform packages are pinned by integrity hash; a changed hash on the same version means republication and must be treated as hostile |

`grok-mermaid` in particular was independently flagged by the original dependency audit
(03-dependency-security.json key_facts #19) *before* any trim was designed, on the same evidence (created
2026-07-28, single maintainer `xl0`, ~1,239 monthly downloads at audit time, zero dependencies, no install
script) — every subsequent report (04, 05, 06, the proposal, and the shipped `high-scrutiny.json`) agrees
it is "the single weakest link in the shipped dependency graph" and that it cannot be trimmed the cheap way
because it is a static, not lazy, import.

## 4. What the shipped repo's own review gate currently shows

This is a finding from re-verifying the actual repo state in this pass, not from the raw reports (which
predate the repo's construction): `strape/audit/reviewed-deps.json` — described in the proposal and in
`strape/CLAUDE.md` as "the build gate," which is supposed to fail the build if any package in the
generated shrinkwrap is absent from a human-reviewed allowlist — currently contains **50 entries, every
one marked `"verdict": "unreviewed"`**. (The 50 external packages plus the 6 internal
`@earendil-works/pi-*` workspace packages account for the SBOM's 56-component total; internal workspace
packages are excluded from `reviewed-deps.json` because they are first-party, not third-party review
targets.)

This is consistent with, not contradictory to, the design: `strape/CLAUDE.md` states explicitly, "Agent
output is evidence for a human sign-off, never the sign-off itself... `reviewedBy`/`reviewedAt` stay null
until a person puts their name in." The infrastructure for the gate (generator scripts, SBOM, high-scrutiny
tiers, capability sweep) is fully built and produces correct, verifiable output — but as of this research
pass, **the human review step itself has not been completed or signed off**. Anyone treating strape as
"already security-reviewed" based on the presence of these files would be mistaken; the gate exists and is
wired up, but is in its initial, not-yet-cleared state.
