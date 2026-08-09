# Security tooling: what is adopted, what it costs, what you still have to do

Every tool below is **installed and running** except Socket.dev, which needs an account, and two GitHub
settings that only exist once the repo is pushed. Nothing here required a purchase.

Selection rationale and the full 24-tool survey: `strape/research/09-dependency-security-tooling.md`.

## The one thing that matters about the shape of this stack

The pre-existing tooling was good at two questions and blind to a third:

| Question | Tools | Status before |
|---|---|---|
| Does this version have a **published advisory**? | `npm audit`, `osv-scanner` | covered |
| Is this artifact the **one we pinned**? | integrity hashes, `lockfile-audit`, `npm audit signatures` | covered |
| Does this package **behave** maliciously, with no advisory yet? | — | **blind** |

That third question is where npm attacks actually live (the 2025 chalk/debug maintainer phishing, Shai-Hulud).
Everything adopted below exists to answer it.

## Running now — no account, no cost

| Tool | Script | What it adds | Cadence |
|---|---|---|---|
| **deps.dev + OpenSSF Scorecard** | `dep-health.mjs` | Reproducible repo-health, deprecation, advisory and publish-age signal per package. Scorecard **without** running the scanner or holding a token — deps.dev serves it. | CI daily, `--check` against baseline |
| **Datadog GuardDog** | `guarddog-scan.mjs` | Malicious-behaviour heuristics over the shipped tarballs: obfuscation, install-script network use, exfiltration shapes, typosquats. The third-party counterpart to `capability-sweep.mjs`. | CI daily + before any new package is allowed |
| **npm provenance extraction** | `provenance.mjs` | Decodes SLSA attestations to record **which repo, commit and workflow built each tarball**, and checks the attested subject digest against our pinned integrity. This is the repo↔tarball linkage nothing else provided. | CI daily, `--check` against baseline |
| **Syft** (Anchore) | `sbom-crosscheck.mjs` | Independent second opinion on the hand-rolled, dependency-free SBOM generator. | CI daily |
| **cosign** | fetched by `fetch-tool.mjs` | Available for ad-hoc Sigstore verification. Routine crypto verification stays with `npm audit signatures`, which already does it in CI — no second implementation to get wrong. | on demand |
| **StepSecurity Harden-Runner** | in `strape-security.yml` | Monitors/restricts what CI steps do on the network. SHA-pinning an action proves identity, not runtime behaviour. Currently **audit** mode. | every CI run |

Measured on first run at pin `v0.84.0`:

- **deps.dev**: 36/50 packages have a Scorecard, mean 4.81. **7 review triggers**, the sharpest being
  `grok-mermaid@0.2.2` published **2 days** before the scan — a fresh version of a single-maintainer package
  that is a direct production dependency. Thresholds were tuned after a first pass flagged 42/50: `Maintained=0`
  and `Code-Review=0` are normal for finished micro-packages and solo maintainers, so they are context, not flags.
- **GuardDog**: 42 packages scanned (8 are other-platform binaries), **3 threat hits** — `jiti` (risk 6.5,
  obfuscation + env read in its bundled Babel), `highlight.js` (Cyrillic identifiers in a language definition),
  `yaml` (`process.env.LOG_TOKENS`). All three match what the manual review concluded, and GuardDog
  independently ranked `jiti` the riskiest package in the closure.
- **provenance**: **18 of 50** have SLSA provenance and **all 18 subject digests match our shrinkwrap**.
  `grok-mermaid` is built from a signed tag (`refs/tags/v0.2.2`); the 11 clipboard packages all come from one
  commit in the pi author's own repo.
- **Syft cross-check**: **0** components in our SBOM that Syft cannot find — the generator invents nothing.
  Syft's 30 extras are example-extension and dev-only trees, i.e. a different scope, and it independently
  surfaced the same 6 internal packages with no integrity hash that HV-3 found.

Every one of these writes a baseline to `strape/audit/` and fails CI on **regression**, not on absolute values.
A low Scorecard is not a vulnerability; a Scorecard that *drops a point* is a review trigger.

Two properties the gates themselves must keep, both learned on 2026-08-08:

- **A tool failure is a gate failure.** `guarddog-scan.mjs --check` compared only threat rules and risk
  scores, and a `scan-error` row carries neither — so 42 consecutive tool failures (a venv whose interpreter
  path broke when the repo moved) printed *"No new threat rules or risk-score increases"* and exited 0. It now
  fails on any package that scanned at baseline and does not scan now, with a backstop for zero coverage.
  This is not an exotic failure: GuardDog is the one tool here installed **unpinned** from PyPI, so a renamed
  flag on `guarddog npm scan` in any routine release breaks every package at once. Pinned by
  `guarddog-gate-test.mjs`, which drives a broken tool, a clean tool, a new threat rule and a risk-score rise
  through stubs, and is negative-tested against the pre-fix scanner.
- **An accepted advisory is recorded, never scoped away.** `npm audit` runs `--omit=dev`; `osv-scanner`
  deliberately does not, because a compromised dev dependency executes on a developer's workstation with the
  provider keys in the environment. Advisories that provably cannot reach a user go in
  `strape/osv-scanner.toml` with a reason and an `ignoreUntil` date, so the exception expires and forces a
  re-triage instead of becoming permanent by inattention. Narrowing the scan to make a finding disappear is
  the one response that is not allowed.

## What you still have to do

Three items, in priority order. The stack works without them; these close the remaining gap.

### 1. Socket.dev account — the only paid/account step, and the highest-value one

Nothing else adopted here answers *"did an approved package's new version gain a capability it did not have
before?"* GuardDog gives a point-in-time verdict; Socket diffs version over version. That difference is the
whole reason it is the anchor recommendation.

```
1. Create an org at https://socket.dev   (free for public repos; ~$25/dev/mo otherwise)
2. Create an API token
3. Add it as the repo secret SOCKET_API_KEY
```

`strape/scripts/socket-scan.mjs` and its CI step are already written. With no key it prints a skip line and
exits 0, so CI is green today and starts enforcing the moment the secret exists — no code change needed.
Optionally also install the Socket GitHub App for PR-time comments; complementary, not required.

### 2. Turn on Dependabot malware alerts (free, one toggle)

`.github/dependabot.yml` is committed, but **malware alerts are a repository setting, not a config file**:

```
Settings -> Advanced Security -> Dependabot alerts -> enable malware alerts
```

Without the toggle you get version bumps only. The config deliberately throttles routine bumps
(3 PR limit, 7-day cooldown, `@earendil-works/*` ignored) because upstream is adopted through the sync
playbook against a reviewed tag, and every other bump must pass the reviewed-deps gate anyway.

### 3. Switch Harden-Runner from audit to block

It is in `strape-security.yml` with `egress-policy: audit`. Run it for a cycle, read the recorded endpoints in
the StepSecurity run summary, then pin them:

```yaml
egress-policy: block
allowed-endpoints: >
  registry.npmjs.org:443
  api.deps.dev:443
  github.com:443
  api.github.com:443
  objects.githubusercontent.com:443
```

Going straight to `block` without reading the audit output will fail builds on an endpoint you forgot.

## Deliberately not adopted

- **Registry proxies** (Sonatype Nexus/Repository Firewall, JFrog Curation, Verdaccio) — they enforce "only
  approved packages may be installed", which `reviewed-deps.json` already enforces for free, without standing
  up and maintaining a registry.
- **Endor Labs, Semgrep Supply Chain reachability, full Sonatype Lifecycle** — built to cut noise across
  thousands of dependencies. A 50-package closure that has already been individually tarball-reviewed does not
  have that problem.
- **Snyk Open Source** — its SCA overlaps `npm audit` + `osv-scanner` entirely, and **Snyk Advisor (the
  package-health product) is being sunset in January 2026**, so building on it would mean migrating again.
- **SonarQube Advanced Security** — Sonar acquired Tidelift (Dec 2024) and that is where its SCA now lives.
  It is enterprise-priced and duplicates coverage we have. SonarQube remains a reasonable *code-quality* choice;
  it is not the answer to the dependency question.
- **npq** — an install-time vetting wrapper; near-zero incremental value once installs are `--ignore-scripts`
  and gated by an allowlist.
- **Phylum** — acquired by Veracode in January 2025 and no longer exists standalone. Do not plan around it.

## The limit of all of it

No tool in the 24-tool survey would have caught this project's most interesting supply-chain finding: the
harness downloading `ripgrep`/`fd` from GitHub's *latest release* and executing them unverified. They are not
npm packages, so every npm-centric tool rates the project clean. It was verified live during the research that
ripgrep's releases publish `.sha256` files but **no** GitHub artifact attestation, so even cosign and
`slsa-verifier` had nothing to check.

That gap was closed by reading the code — `capability-sweep.mjs` asking "what are all the network egress and
process-exec sites?" and a human following up. Keep doing that. Tools cover the known shapes; the capability
review is what finds the shapes nobody has named yet.
