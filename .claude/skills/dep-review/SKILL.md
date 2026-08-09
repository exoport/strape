---
name: dep-review
description: Review strape's npm dependency closure and record verdicts in strape/audit/reviewed-deps.json — the gate that blocks the build until every shipped package is cleared. Use when the reviewed-deps gate fails, when adopting an upstream release that changes the lockfile, or when asked to audit dependencies / supply-chain risk.
---

# strape dependency review

The build gate is `node strape/scripts/reviewed-deps.mjs`: every external package in
`packages/coding-agent/npm-shrinkwrap.json` must appear in `strape/audit/reviewed-deps.json` with a matching
integrity hash and `verdict: "allow"`. This skill is how those verdicts get produced.

**Review the tarball, not the repo.** What executes is what npm unpacked into `node_modules`. A
repo↔tarball mismatch is itself a classic attack, so an agent that reads GitHub instead of the installed
package has not reviewed the dependency.

**Review the exact nesting path, not `node_modules/<name>`.** Every entry in `reviewed-deps.json` carries a
`shrinkwrapPath` — use it verbatim. A nested copy and a hoisted top-level copy of the same package name are
different tarballs at different versions, and reviewing the wrong one proves nothing.

> This is not hypothetical. In the v0.84.0 review an agent was given the bare name `retry` and reviewed
> `node_modules/retry@0.13.1`, while the shipped closure actually contains
> `node_modules/proper-lockfile/node_modules/retry@0.12.0`. The dev tree hoists a *different* `retry` for a
> devDependency. `reviewed-deps.mjs` now fails with `artifact-mismatch` when the on-disk version at the
> nesting path disagrees with the shrinkwrap, but the first defence is using the right path.

Before reviewing, confirm you have the right artifact:

```sh
node -e 'console.log(require("./<shrinkwrapPath>/package.json").version)'   # must equal the entry version
```

## Step 0 — deterministic first (no AI)

```sh
npm ci --ignore-scripts --no-audit --no-fund      # never without --ignore-scripts
npm run shrinkwrap:coding-agent                   # expect: 56 packages, 10 platform-specific
node strape/scripts/lockfile-audit.mjs            # registry host, https, integrity, exact pins, .npmrc
node strape/scripts/sbom.mjs                      # CycloneDX 1.6, purl + sha512 per component
npm audit --omit=dev --audit-level=moderate
npm audit signatures --omit=dev                   # needs a REAL install; --package-lock-only cannot verify
node strape/scripts/reviewed-deps.mjs --report    # what is still unreviewed
node strape/scripts/reviewed-deps.mjs --seed      # skeleton entries (verdict "unreviewed" — still fails)
```

If `osv-scanner` is present in `strape/tools/`, verify its hash before use, then:
`sha256sum -c strape/tools/osv-scanner.sha256 && strape/tools/osv-scanner --lockfile=package-lock.json`

`npm audit` finding nothing is expected and is **not** the review. It only knows published advisories; it
cannot tell you a package gained a network call, a postinstall, or a new maintainer.

## Step 1 — tier the closure

Tier A (**full read** of shipped files): anything with a dangerous capability or thin trust.
`undici`, `http-proxy-agent`, `https-proxy-agent`, `cross-spawn`, `jiti`, `openai`, `proper-lockfile`,
`grok-mermaid`, `@silvia-odwyer/photon-node`, `@mariozechner/clipboard` (+ the platform binary it loads),
`glob`/`path-scurry` (filesystem traversal), `yaml` and `marked` (parse attacker-controlled input).

Tier B (**capability scan + spot read**): small, single-purpose, huge install base — `chalk`, `semver`,
`debug`, `ms`, `diff`, `ignore`, `minimatch`, `brace-expansion`, `balanced-match`, `lru-cache`, `minipass`,
`graceful-fs`, `isexe`, `which`, `path-key`, `shebang-*`, `signal-exit`, `get-east-asian-width`,
`partial-json`, `typebox`, `@opentelemetry/api`, `hosted-git-info`, `highlight.js`.

Tier C (**cannot be meaningfully read** — minified/bundled dist, e.g. `openai`, WASM in `photon-node`,
native `.node` binaries in `@mariozechner/clipboard`): record that explicitly. The review basis becomes
provenance attestation + capability scan + version pinning + the runtime denylist, and the entry says so.
Never write `verdict: allow` with a claim of a full read that did not happen.

## Step 2 — per-package review (one agent per package, sonnet; opus for Tier A)

Give each agent the package directory and require it to check, with `file:line` evidence:

1. **Install scripts** — `scripts.{pre,post}install`, `scripts.prepare` in the tarball's `package.json`.
   The shipped closure must be at 0; the allowlist in both generators is empty on purpose so a new one is a
   hard build failure.
2. **Capabilities** — `child_process`, `eval`/`new Function`, `vm`, `fs` writes, `net`/`http`/`fetch`,
   `process.env` reads, dynamic `require`/`import`, native `.node` loads, WASM instantiation.
3. **Network endpoints** — every hardcoded host. Anything that is not an LLM provider endpoint is a finding.
4. **Obfuscation / mismatch** — minified or encoded source in a package whose stated purpose does not need
   it; base64 blobs; behaviour that exceeds the README's claim; unexpected `bin` entries.
5. **Trust signals** — maintainer count, publish age, download volume, repository field present and matching,
   whether the tarball has a provenance attestation (`npm audit signatures` output).
6. **Files actually loaded** — entry points from `main`/`exports`, and whether a smaller subset is what
   strape reaches (`typebox` and `glob` ship far more than pi uses).

Verdict schema per package (`strape/audit/reviewed-deps.json`):

```json
"chalk@5.6.2": {
  "verdict": "allow",              // allow | escalate | unreviewed | reject
  "integrity": "sha512-…",         // must match the shrinkwrap
  "resolved": "https://registry.npmjs.org/…",
  "hasInstallScript": false,
  "installScriptApproved": false,  // required true if hasInstallScript
  "tier": "B",
  "reviewedBy": "<name>",
  "reviewedAt": "YYYY-MM-DD",
  "capabilities": ["env"],         // from step 2
  "notes": "terminal colour only; reads process.env for TTY/FORCE_COLOR; no net/exec/fs"
}
```

Adversarially verify every `escalate`/`reject` and every Tier A `allow` (a wrong `allow` is the expensive
mistake): a second agent tries to refute the verdict from the same files.

## Step 3 — high-scrutiny register

`strape/audit/high-scrutiny.json` holds the class no scanner catches: young, single-maintainer, or
low-download packages that are nonetheless production dependencies. CI fails if any entry's version drifts.
Mandatory initial entries — `grok-mermaid@0.2.2` (created 2026-07-28, single maintainer, ~1.2k downloads/mo,
statically imported by the interactive TUI so it cannot be denylisted), `proper-lockfile@4.1.2` (unpublished
since 2022), `@silvia-odwyer/photon-node@0.3.4` (single maintainer, WASM).

Escalation if a read raises doubt: vendor into `strape/vendor/<pkg>` with a root `overrides` `file:` entry
(costs one lockfile regeneration), or remove the feature that needs it.

## Step 4 — record and gate

```sh
node strape/scripts/reviewed-deps.mjs --report   # must print PASSED
node strape/scripts/sbom.mjs                     # commit as the new baseline
```

Commit `reviewed-deps.json`, `high-scrutiny.json`, `sbom-<pin>.json` together with the review record. The
gate passing is the artifact that says "this build was allowed"; do not bypass it to unblock a build.

## Diff mode (upstream bump)

```sh
PIN=$(cut -d' ' -f1 strape/audit/UPSTREAM_PIN)
git diff $PIN..<target> -- package-lock.json | head -200
npm run shrinkwrap:coding-agent && node strape/scripts/sbom.mjs --check strape/audit/sbom-$PIN.json
```

Only added/changed components need review. A version bump of an already-reviewed package still needs a real
look at the diff between the two tarballs — that is exactly where a compromised release lands:

```sh
npm pack <pkg>@<old> && npm pack <pkg>@<new> && diff -r <extracted dirs>
```

Removed packages: delete the entry (the gate reports stale entries) and note it in the review record.

## Rules

- `--ignore-scripts` on every install, always.
- No verdict without a named reviewer and a date. The gate enforces presence; honesty is on the reviewer.
- Never allow a package because it is popular. Popularity is a trust signal, not a review.
- If a package cannot be read (Tier C), the entry must say so — an honest "reviewed by provenance + scan"
  is worth more than a false claim of a full read.

## Automated signals to run BEFORE the agent review (adopted 2026-08-07)

These are cheap, reproducible, and narrow the human/LLM effort to what actually needs judgment. Full rationale
in `strape/docs/SECURITY-TOOLING.md`; tool survey in `strape/research/09-dependency-security-tooling.md`.

```sh
node strape/scripts/dep-health.mjs                 # deps.dev + OpenSSF Scorecard: health, deprecation, age
node strape/scripts/dep-health.mjs --suggest        # cross-check high-scrutiny.json against real signals
node strape/scripts/guarddog-scan.mjs               # GuardDog: malicious-behaviour heuristics per tarball
node strape/scripts/provenance.mjs                  # which repo/commit/workflow built each tarball
node strape/scripts/fetch-tool.mjs syft && node strape/scripts/sbom-crosscheck.mjs
SOCKET_API_KEY=... node strape/scripts/socket-scan.mjs   # version-over-version behavioural diff
```

How to use the output when reviewing a package:

- **`dep-health` flags** are review triggers, never verdicts. A low Scorecard is not a vulnerability — most npm
  micro-packages score 3-5. What matters is `young:<Nd>` on a package you are about to trust, `deprecated`,
  a new `advisories:` entry, or a **drop** against the baseline.
- **`guarddog-scan` threat hits** tell you where to look first. Expect false positives from bundled code
  (`jiti`'s vendored Babel trips obfuscation rules; a regex `.exec()` trips process-spawn). Read the cited
  `location` before believing it; GuardDog's own risk score is usually the better signal than the rule list.
- **`provenance`** gives you the source repo and commit for attested packages — use it to diff a tarball
  against the tag it claims to come from, which is the one check no other tool here performs. 18 of 50 packages
  have it; the other 32 fall back to integrity pinning alone, and the review note should say so.
- **`--suggest`** is the honest replacement for hand-picking `high-scrutiny.json`. It will also tell you when a
  registered package shows no automated signal — keep those entries anyway if the reason is something deps.dev
  cannot see (unreadable WASM, native binaries, a single maintainer).

**None of these replace reading the tarball.** They cover the known shapes. The `rg`/`fd` unverified-download
finding — this project's most interesting supply-chain result — was invisible to every one of them because the
binaries are not npm packages.
