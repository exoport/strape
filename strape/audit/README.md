# strape/audit — the release-gate record

strape exists so that we own our own release gate: we decide which upstream tag we run and which dependencies
ship, and we decide it after looking at what changed. This directory is the record of those decisions, and the
machine-readable state every CI gate checks against.

## Why this is all public

Upstream pi's security policy puts this whole class of issue out of scope — it excludes "risks from working in
untrusted repositories" and reports that require creating symlinks or workspace files on the target machine. So
the weaknesses described in these documents are, by upstream's own published position, working as intended
rather than undisclosed vulnerabilities; there is nothing to coordinate. The analysis is derived entirely from
public source, and the issues strape has fixed are legible in the source diff and its regression tests anyway.

What differs is our threat model, not our assessment of upstream. strape runs against repositories cloned from
the internet, so content arriving in a checkout is untrusted input here even where upstream reasonably treats it
as user-controlled local state. That difference, not a judgement about upstream's engineering, is why these files
exist.

## Machine-readable state (what the gates check)

| File | What it is | Read by |
|---|---|---|
| `UPSTREAM_PIN` | the upstream tag + commit this tree is cleared for | 6 scripts/workflows |
| `review-attestation.json` | a named sign-off bound to a digest of the reviewed content | `review-attest --verify` (the CI enforcement point) |
| `reviewed-deps.json` | per-package verdict + integrity hash — **the build gate** | `reviewed-deps.mjs` |
| `sbom-<pin>.json` | CycloneDX 1.6 of the shipped closure | `sbom.mjs --check`, `sbom-crosscheck.mjs` |
| `capability-sweep-<pin>.json` | every exec/network/fs/credential site, as a drift baseline | `capability-sweep.mjs --check` |
| `dep-health-<pin>.json` | deps.dev + OpenSSF Scorecard baseline | `dep-health.mjs --check` |
| `provenance-<pin>.json` | which repo/commit/workflow built each attested tarball | `provenance.mjs --check` |
| `guarddog-<pin>.json` | malicious-behaviour scan baseline | `guarddog-scan.mjs --check` |
| `high-scrutiny.json` | thin-trust packages, pinned by version + integrity | `high-scrutiny-check.mjs` |
| `expected-test-failures.json` | the exact set of tests that fail by design | `test-expectations.mjs` |
| `vendored-tools.json` | pinned sha256 for `rg`/`fd` | `provision-tools.mjs` |

## The written record

| File | What it is |
|---|---|
| `review-v<pin>.md` | the source review: scope, method, findings by severity, accepted-risk register, coverage limitations, sign-off block |
| `hand-verified-findings.md` | HV-1..HV-9 — checked by hand rather than taken from an agent, including two flaws found in strape's own review tooling |
| `dep-review-v<pin>.md` | per-package dependency review and the reasoning behind each escalation |
| `capability-map/` | 12 sections mapping what each area of the harness can do, with `file:line`, trigger and guard |

Related: `strape/docs/SECURITY-BACKLOG.md` turns all of this into what we hardened (Part 1) and what still needs
work (Part 2).

## Current state, stated plainly

Two gates fail on purpose:

- **`reviewed-deps`** — 26 of 50 dependency verdicts are `escalate`, each a question a human still has to answer.
- **`review-attest`** — no sign-off is recorded, so nothing is cleared for release yet.

That is the correct state for a review that has gathered evidence but not been signed off. Clearing them is
Phase 2 in `strape/docs/RELEASE-FLOW.md`. Do not work around either — a passing gate is the artifact that says
a human made the call, and there is no point owning a gate you route around.
