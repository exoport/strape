# How the security review is actually performed

This file answers the operational question: *how do you security-review ~70k LOC of first-party source and a
50-package dependency closure using tooling and Claude Code, at a cost you can pay again every month?* It is
the design record for `.claude/skills/source-audit` and `.claude/skills/dep-review` in the strape repo, and
it reflects what was actually run on 2026-08-06 against upstream pi `v0.84.0`, not a proposal.

The governing idea: **a human never reads 70k LOC. A human signs off on artifacts.** Tooling and agents
produce small, checkable, regenerable artifacts; the human's job is to verify those artifacts are honest and
to put their name on them. Every artifact is diffable, so next month's review is a diff review.

## The three layers

| Layer | Who | Cost | Output |
|---|---|---|---|
| 1. Deterministic tooling | scripts, no AI | seconds | capability sweep, lockfile audit, SBOM, advisories, signatures |
| 2. Claude Code agents | ~29 (source) + ~50 (deps) | ~1 h wall clock | capability map sections, findings with attack paths, per-package verdicts |
| 3. Human sign-off | a person | ~1-1.5 days | `reviewedBy`/`reviewedAt` in the gate files, `review-<pin>.md` |

Layer 1 exists because agent coverage cannot be audited after the fact — you cannot prove an LLM looked at
every `spawn()` call. A regex sweep can be re-run and diffed forever, so it is what makes the *next* review
cheap. Layer 2 exists because layer 1 cannot tell you whether a capability is *guarded*. Layer 3 exists
because agent output is evidence, never authority.

### Layer 1 — deterministic, no AI

| Script | What it proves |
|---|---|
| `strape/scripts/capability-sweep.mjs` | every site that can exec, eval, reach the network, write files, read credentials, use temp paths, parse untrusted input, or make a trust decision. 1339 sites over 454 files at v0.84.0. `--check` turns the reviewed result into a drift gate. |
| `strape/scripts/lockfile-audit.mjs` | every package resolves from `registry.npmjs.org` over https with an integrity hash; no git/file deps; no lifecycle scripts in the shipped closure; all direct deps exactly pinned; `.npmrc` posture intact |
| `strape/scripts/sbom.mjs` | CycloneDX 1.6 of the *shipped* closure with purl + sha512 per component; no timestamp, so it diffs cleanly release-over-release |
| `strape/scripts/high-scrutiny-check.mjs` | the thin-trust packages have not moved version or been republished under the same version |
| `npm audit --omit=dev` / `npm audit signatures` | published advisories; registry signatures and provenance attestations. **`--package-lock-only` cannot verify signatures** — a lockfile-only pipeline silently loses that coverage, so this needs a real install |
| `strape/tools/osv-scanner` (pinned + hash-verified) | advisories npm's feed misses |
| `semgrep` / CodeQL (optional) | taint flows regex cannot see (command injection, path traversal) |

Measured on 2026-08-06 against the built strape tree: 0 advisories (dev and prod), 309/309 packages with
verified registry signatures, 61 with provenance attestations, osv-scanner clean on both the 416-package dev
lockfile and the 56-package shipped closure.

### Layer 2 — Claude Code, two jobs

Both jobs run as `Workflow` scripts so the fan-out is deterministic and re-runnable, and both are encoded as
skills so they can be re-invoked in **diff mode** on the next upstream bump.

**Job A — first-party source.** Four phases:

1. **Capability map, 12 sonnet agents in parallel**, one per area (`core-tools`, `core-extensions`, `core-a`,
   `core-b`, `cli-entry`, `utils`, `core-subsystems`, `interactive-a`, `interactive-b`, `ai-openai-xai`,
   `agent-core`, `tui`). Each is handed the sweep JSON, reads the actual code at every capability site in its
   scope, and writes `strape/audit/capability-map/<area>.md` containing a table of
   `file:line | what | trigger | guard | attacker-influenced?`, **plus an explicit list of dismissed sweep
   hits with reasons, plus capabilities the sweep missed**. Those two negative sections are what make the
   section auditable rather than merely plausible.
2. **Threat review, 8 opus agents (effort high)** on the hot paths: `tool-exec`, `tool-fs`, `extensions`,
   `package-manager`, `trust-auth`, `session-export`, `net-secrets`, `context-skills`. Each is required to
   produce a concrete attack path (what the attacker controls → what they do → what they get), quoted
   evidence with `file:line`, **and** `assurance_notes` for things checked and found sound — a review that
   only lists problems is not evidence of coverage.
3. **Adversarial verification, one sonnet skeptic per finding**, default verdict REFUTED, explicitly
   prompted to refute: the guard may exist, the input may not be attacker-controllable, the path may need a
   human approval the finding glossed over, the severity may assume a capability the code lacks, or it may
   just restate upstream's documented accepted risk. REFUTED findings stay in the record with reasons.
4. **Synthesis, 1 opus agent** writing `capability-map-<pin>.md` and `review-<pin>.md`, including a
   coverage-limitations section.

Phases 2 and 3 are pipelined, not barriered: each area's findings go to verification as soon as that area's
review lands.

**Job B — the dependency closure.** Tiered, because uniform effort is wasted effort:

- **Tier A, full read of the shipped tarball** (opus): dangerous capability or thin trust — `undici`,
  `http-proxy-agent`, `https-proxy-agent`, `cross-spawn`, `jiti`, `proper-lockfile`, `grok-mermaid`,
  `glob`/`path-scurry`, `yaml`, `marked`, `hosted-git-info`, `@mariozechner/clipboard`.
- **Tier B, capability scan + spot read** (sonnet): small, single-purpose, huge install base — `chalk`,
  `semver`, `debug`, `ms`, `diff`, `ignore`, `minimatch`, `lru-cache`, `minipass`, `graceful-fs`, `isexe`,
  `which`, `path-key`, `shebang-*`, `signal-exit`, `typebox`, `@opentelemetry/api`, `highlight.js`, …
- **Tier C, unreadable by construction**: minified `openai`, WASM `photon-node`, native `.node` binaries.
  The review basis is provenance + capability scan + pinning, and the verdict entry must **say so**.

Each agent returns a structured verdict that becomes an entry in `strape/audit/reviewed-deps.json`
(`verdict`, `integrity`, `tier`, `capabilities`, `notes`). Verdicts of `escalate`/`reject`, and every Tier A
`allow`, get an adversarial second pass — a wrong `allow` is the expensive mistake.

**Review the tarball, not the repo.** What executes is what npm unpacked into `node_modules`. Repo↔tarball
mismatch is itself a classic attack, so an agent that reads GitHub instead of `node_modules/<pkg>` has not
reviewed the dependency.

### Layer 3 — human sign-off

The human reads `capability-map-<pin>.md`, the confirmed findings, the Tier A verdicts and the SBOM — then
fills `reviewedBy`/`reviewedAt` and signs `review-<pin>.md`. Until that happens the gate files are honest
about their state: every entry seeded by tooling carries `verdict: "unreviewed"`, which **fails the build**.

## Why this is credible rather than theatre

- **The gate is code, not discipline.** `reviewed-deps.mjs` fails the build on any shipped package without an
  `allow` verdict and a matching sha512. Verified working: with all 50 packages seeded as `unreviewed`, the
  build gate exits 1 and names each one.
- **Agent claims are cross-checked.** Load-bearing claims were re-verified by hand. Two examples from
  2026-08-06: the `piConfig` rename seam was confirmed at `config.ts:487-496` before relying on it, and the
  capability map's claim about unverified binary downloads was confirmed independently at
  `utils/tools-manager.ts:108-123` and `:265-271` before acting on it.
- **Nothing silently vanishes.** Dismissed sweep hits, refuted findings, and unreadable packages are all
  recorded with reasons.
- **Drift is mechanical.** `capability-sweep --check`, `sbom --check` and `high-scrutiny-check` fail CI when
  the reviewed baseline moves, which converts "did anything security-relevant change?" from a judgement call
  into an exit code.

## The finding that justifies the whole approach

The capability map found, and hand-verification confirmed, that pi resolves `ripgrep`/`fd` versions from
GitHub's *latest release* API at runtime, downloads the archives, extracts them, and executes the binaries
with **no checksum, no signature, and no pinned version** (`utils/tools-manager.ts:108-123`, `:265-271`;
spawned at `core/tools/grep.ts:221` and `core/tools/find.ts:264`).

This matters beyond the specific bug: rg and fd are **not npm packages**, so the entire npm-centric control
stack — lockfile pinning, the shrinkwrap integrity hashes, the SBOM, `npm audit`, the reviewed-deps gate —
never mentions them. A dependency review that only looked at `package-lock.json` would have rated this
codebase clean while a fresh install fetched and executed unverified native binaries on first `grep`.

It was caught because layer 1 asked the mechanical question "what are all the network egress and process-exec
sites?" and layer 2 read what those sites actually do. strape's response is
`strape/scripts/provision-tools.mjs`: pinned versions, sha256 recorded in `strape/audit/vendored-tools.json`,
verify-before-install, refuse-on-mismatch — with `PI_OFFLINE=1` in the launcher keeping upstream's unverified
path closed by default.

## Costs measured, not estimated

| Activity | Cost |
|---|---|
| Layer 1, all scripts | seconds; the full sweep is ~1 s over 454 files |
| Job A (29 agents: 12 sonnet map + 8 opus review + verifiers + synthesis) | ~1 h wall clock at 6-way concurrency on 8 cores |
| Job B (~50 package agents, tiered) | comparable |
| Human sign-off | ~1-1.5 days for the first baseline |
| **Per upstream release, diff mode** | 30-60 min, dominated by human reading of the source diff |

Concurrency is capped at `min(16, cores-2)` = 6 here, which is also what keeps this inside API rate limits.

## Diff mode — the monthly path

```sh
PIN=$(cut -d' ' -f1 strape/audit/UPSTREAM_PIN)
node strape/scripts/sync.mjs --target v0.86.0          # stage A prints exactly what must be reviewed
node strape/scripts/capability-sweep.mjs --check strape/audit/capability-sweep-$PIN.json
node strape/scripts/sbom.mjs --check strape/audit/sbom-$PIN.json
```

If no hot-path file changed and both drift checks pass, one agent reviews the whole source diff and the
record is a short delta. If a hot path changed, one opus agent per changed hot path reviews the diff with
context, plus adversarial verification. New capability sites and new network hosts are findings until
explained. `/security-review` on the merge branch is a useful extra pass, not a replacement.

## Known limitations (state these, do not paper over them)

- **No sandbox, and prompt injection is unmitigated** — upstream's documented design. The review can only ask
  what injected text can do *without* a human approving it; it cannot make the harness safe against a
  malicious repo. Containerisation remains the user's decision.
- **Tier C packages are not read.** `openai` ships minified, `photon-node` ships WASM, `@mariozechner/clipboard`
  ships native binaries. Pinning plus provenance is the control, and the register says so.
- **Coverage of very large files is uneven.** `interactive-mode.ts` alone is several thousand lines; the
  capability-map agents were directed at its capability sites rather than reading it whole. The
  coverage-limitations section of `review-<pin>.md` records this.
- **Agent review is not a proof.** It finds what it looks for. The deterministic layer, the adversarial pass,
  and the drift gates exist precisely because the agent layer is fallible.
