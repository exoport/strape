# Dependency / Supply-Chain Security Tooling: What Else Should strape Adopt?

This file answers: given the controls strape already has (npm audit + signatures, osv-scanner v2.4.0,
a custom CycloneDX SBOM generator, a custom lockfile-hygiene audit, `reviewed-deps.json`,
`high-scrutiny.json`, a manual+LLM tarball review of all 50 shipped packages, a first-party capability
sweep, `--ignore-scripts`, and SHA-pinned Actions — see `strape/research/03-dependency-security-baseline.md`),
**what commercial or open-source tools would add real coverage, not duplicate coverage**, and which of six
named residual gaps each one actually closes:

1. No detector for a *behavioural* change in an already-approved package's new version (new network call,
   new postinstall, new native code).
2. No maintainer/repo-health or account-takeover-risk score — the `high-scrutiny.json` tiers are entirely
   hand-maintained.
3. Tier C packages (minified JS, WASM, prebuilt native binaries) can't be read — no reproducible-build,
   provenance/SLSA, or binary-diffing tooling in the current stack.
4. Nothing verifies a published tarball actually corresponds to the git tag/commit it claims to come from.
5. Non-npm binaries fetched at runtime (`ripgrep`/`fd` from GitHub Releases) are invisible to every npm
   tool.
6. No pre-advisory detection of typosquats, dependency confusion, or freshly-published malicious packages.

Research was done live in August 2026 via web search against vendor sites, changelogs, and independent
reviews, specifically to catch acquisitions/renames/sunsets that would make a knowledge-cutoff-based answer
wrong. Three names on the requested list turned out to have changed status since they entered common
knowledge — flagged in bold in §2 and again in §3.

## 1. Summary of what's genuinely new here

The existing stack is already excellent at **"detects known vulnerabilities"** (npm audit, osv-scanner) and
**"detects tampering with an already-fetched artifact"** (integrity hashes, lockfile hygiene, signatures).
It has almost nothing that does **"detects malicious or anomalous *behaviour* that has no CVE yet"** — which
is exactly the category gaps 1, 2, and 6 describe, and exactly the category the whole npm threat landscape
moved into in 2025–2026 (Shai-Hulud, Shai-Hulud V2/"Mini Shai-Hulud", the tj-actions breach, the September
2025 chalk/debug maintainer-phishing incident). The single highest-value addition is a tool built for
*that* category — Socket.dev is the clearest fit and is treated as the anchor recommendation below.

## 2. Comparison table

| Tool | What it actually does | OSS / Commercial (pricing) | Gaps closed | Integration |
|---|---|---|---|---|
| **Socket.dev** | Static + dynamic behavioral analysis of package code (network/fs/shell/eval/env-var use); diffs each new version of a tracked dependency against the last and alerts on *newly introduced* install scripts, native code, or privileged-API use; maintainer/typosquat/dependency-confusion scoring; malware feed with same-day detections | Commercial, free tier for OSS/public repos and a free "Socket Firewall"; paid Team $25/dev/mo, Business $50/dev/mo, Enterprise custom [socket.dev/pricing](https://socket.dev/pricing) | **1** (version-diff/new-capability alerts, its core differentiator), **2** (maintainer/quality/typosquat scores), **6** (malware feed, same-day detections, blocks before advisory exists) | GitHub App (PR comments/blocking), CLI (`socket scan create`, `socket scan diff`), npm-install wrapper/Firewall |
| **Snyk Open Source** / ~~Snyk Advisor~~ | Known-CVE SCA (commodity, redundant with npm audit/osv-scanner here). **Snyk Advisor (the package-health-score product) is being sunset in January 2026**, folded into static package pages on security.snyk.io — it is no longer a live, queryable gate | Commercial (Open Source product); Advisor was free and is being discontinued | None of 1–6 beyond what's already covered (no malware-specific feed comparable to Socket/Phylum-in-Veracode) | CLI/CI/IDE (Open Source product only; Advisor has no integration going forward) |
| **GitHub Dependabot + Dependency Review Action** | Dependabot: version-bump PRs + (as of **17 Mar 2026**) opt-in malware alerts matching npm deps against the GitHub Advisory Database, expanded **28 Jul 2026** to ingest OpenSSF's `malicious-packages` feed across 8 ecosystems; a default 3-day update "cooldown" added in 2026 to blunt worm-style propagation. Dependency Review Action: PR-time license allow/deny-list + "fail on severity" gate | Free (public repos) / included with GHAS (private) | Partial **6** (known-malware matching only — not ahead of the advisory, but faster than a manual `npm audit` cadence, and the cooldown directly mitigates the propagation window worms rely on) | Repo/org toggle (Dependabot); GitHub Action (`actions/dependency-review-action`) |
| **OpenSSF Scorecard** | 18 automated checks per GitHub repo (Maintained, Branch-Protection, Code-Review, Dangerous-Workflow, Signed-Releases, etc.), 0–10 each | Free, OSS (Apache-2.0), Linux Foundation | **2** (the whole point of the tool) | GitHub Action (`ossf/scorecard-action`) publishing SARIF; also queryable via the free deps.dev API without running anything yourself |
| **deps.dev** (Google) | Free API/BigQuery dataset covering npm+4 other ecosystems: computed (not just declared) dependency graphs, license data, advisories, and it **already surfaces each package's OpenSSF Scorecard score** on its per-package page; also supports hash→package lookup (useful forensic/SBOM cross-reference) | Free, no login | **2** (via the surfaced Scorecard data, at zero build cost) | REST/gRPC API, BigQuery; osv-scanner's `--experimental-licenses` flag already pulls license data from it |
| **Sonatype Nexus Lifecycle / IQ Server / Repository Firewall** | Nexus IQ Server powers Lifecycle (SCA) and Repository Firewall (proxy-layer blocking of malicious/non-compliant components before they reach a developer, using Sonatype's own research team's threat intel — independent testing found Sonatype's malware-detection *speed* to be genuinely ahead of competitors) | Commercial, quote-only; reviews describe it as the priciest option in this category, Firewall is a ~30-45% premium over Lifecycle | **1** (partial — Firewall's own version-monitoring), **6** (proactive block, strong detection speed) | Registry-proxy control point (requires standing up Nexus Repository as the install path), IDE plugins, CI |
| **JFrog Xray / Curation** | Xray: continuous SCA scanning against a 2.8M-artifact malicious-package catalog (self-reported). Curation: proxy-layer blocking at Artifactory, holds newly-published npm versions for a 14-day cooldown by default, "Compliant Version Selection" hides non-compliant versions entirely from `npm install` | Commercial, quote-only | **1** (partial, cooldown mitigates fast-propagating worm versions), **6** | Registry-proxy control point (requires Artifactory), CI plugin |
| **Mend.io** (formerly WhiteSource) | Commodity SCA + a malicious-package detector (technology acquired from Diffend) covering typosquats/dependency-confusion/exfiltration patterns across 200+ language/ecosystem combos | Commercial, quote-only | **6** (partial — signature/heuristic based, not real-time-fastest per market commentary) | CLI/CI/IDE |
| **Endor Labs** | Function-level reachability analysis across 40+ ecosystems (is the vulnerable function of a dependency actually called by your code?); also scans for malicious packages and 150+ risk factors | Commercial, enterprise/contact-sales only | **1** (partial, via risk-factor scanning), **2** (partial), **6** (partial) | CLI/CI, code+dependency graph platform |
| ~~Phylum~~ | **Acquired by Veracode, January 2025 — no longer an independent product or brand.** Its malicious-package database and package-firewall technology now ship inside Veracode's SCA product | N/A (absorbed) | N/A as a standalone tool; via Veracode SCA: **6** | Would be Veracode's platform, not Phylum's |
| **Datadog GuardDog** | Free OSS CLI: correlates static code "capabilities" (network, exec, obfuscation, env-var reads, etc., via YARA + Semgrep rules) with threat indicators to score npm/PyPI/Go/Cargo/RubyGems/GitHub Actions/VS Code packages 0–10; sandboxed archive extraction since a couple of its own CVEs. Version 3.0 shipped mid-2026 and it's still actively maintained | Free, OSS (Apache-2.0), Datadog Security Labs | **1** (point-in-time capability/threat correlation — run per new/updated tarball, it's the closest OSS analog to Socket's engine), **6** (heuristic typosquat/obfuscation signals) | CLI (`guarddog npm scan <pkg>`, `guarddog npm verify package-lock.json`) |
| **npq** | Free OSS CLI wrapper around `npm install`: checks package age, download popularity, README/LICENSE presence, install-script presence, and queries Snyk's vuln DB, before letting the real install proceed. Still maintained (pushed 23 Jul 2026, 1.7k GitHub stars) | Free, OSS | Very partial **1**/**6** — every check it does is already exceeded by strape's `min-release-age=2` + `reviewed-deps.json` gate | CLI wrapper/shell alias |
| **Trivy** | All-in-one OSS scanner: container/IaC/secrets/SBOM/vuln scanning, including npm lockfiles, against the same class of vulnerability databases osv-scanner already covers | Free, OSS (Apache-2.0), Aqua Security | None beyond what osv-scanner + the custom SBOM generator already do | CLI/CI, single static binary |
| **Syft / Grype (Anchore)** | Syft: SBOM generator (CycloneDX/SPDX/its own JSON) for 20+ ecosystems including npm. Grype: consumes an SBOM and matches against a vuln DB, now enriched with EPSS score + KEV-catalog status + a composite risk score | Free, OSS (Apache-2.0), Anchore | None of 1–6 directly, but useful as an **independent cross-check** of the custom CycloneDX SBOM generator (diff Syft's component list against the bespoke generator's output to catch generator bugs/omissions) | CLI/CI |
| **sigstore/cosign + slsa-verifier** | `cosign verify-blob-attestation` cryptographically verifies an npm package's provenance bundle (ties tarball → exact GitHub Actions workflow/commit that built it) for the subset of packages that publish provenance; `slsa-verifier` does the equivalent for SLSA-attested build artifacts generally | Free, OSS, Sigstore/OpenSSF/SLSA | Partial **4** (proves tarball came from a claimed CI workflow — does *not* prove that workflow's output matches the tagged source, which is the deeper form of gap 4; see §5 and Google OSS Rebuild below) | CLI (`cosign`, `slsa-verifier`), scriptable in CI |
| **StepSecurity Harden-Runner** | CI/CD "EDR" for GitHub Actions runners: baselines then monitors/blocks network egress, watches file integrity and process activity; ships a globally-maintained block-list of domains tied to active supply-chain campaigns; credited with catching the tj-actions/changed-files breach in the wild | Free (Community, public repos, unlimited); Enterprise $16/contributing-dev/mo | Not one of 1–6 directly — it hardens *strape's own CI pipeline* (the thing that builds the SBOM/shrinkwrap/reviewed-deps gate) against a compromised action or a dependency's build/test step phoning home, which none of gaps 1–6 explicitly names but which the "SHA-pinned Actions" control doesn't fully cover (a pinned action can still misbehave post-pin if its *runtime* behavior changes) | One-line first step in each GitHub Actions job |
| **Semgrep Supply Chain** | Reachability-based SCA — dataflow-traces whether a vulnerable dependency function is actually reachable from application code, claims ~95% SCA false-positive reduction (vendor-reported, unverified) | Commercial, bundled into Semgrep Team ($35/contributor/mo, free ≤10 contributors) | Marginal for this project — reachability analysis solves a triage/noise problem that doesn't exist at 50 hand-reviewed packages | CLI/CI |
| **Aikido Security** | Bundled AppSec platform: SAST+SCA+secrets+DAST+IaC+CSPM+malware-in-dependencies feed+"Registry Proxy" to block malware at a private registry | Commercial, flat-rate (not per-dev): free tier (2 users/10 repos), paid from $350/mo | **1** (partial, via malware feed), **6** | SaaS dashboard, CI, registry proxy |
| **Chainguard Libraries (for JavaScript)** | Rebuilds npm packages from verified source in an isolated, SLSA-Build-Level-3 pipeline; **refuses to build anything whose source can't be attributed, and refuses anything using an install-time script at all**; served as an npm-protocol-compatible registry endpoint. An independent Chainguard study claims this would have blocked ~99% of a sample of 8,783 known-malicious npm packages | Commercial; was **free for all languages through 30 June 2026** — that trial window has now passed and current pricing is quote-only as of this research; verify before assuming free access | **3** and **4** together, for whatever fraction of strape's 50 packages exist in its catalog — a rebuild-from-verified-source *is* a tarball↔source correspondence proof, stronger than provenance alone | Alternate npm-protocol registry endpoint (would sit alongside or instead of `registry.npmjs.org`, in tension with the existing lockfile-hygiene rule — see §4) |
| **Verdaccio** (or any self-hosted registry proxy) | Lightweight self-hosted npm-protocol proxy/cache; can restrict which packages/scopes resolve at all, enforce authenticated-only access, prevent dependency confusion on private scope names | Free, OSS | Would let an allowlist be enforced at the network layer instead of (or in addition to) at build-gate time — not a new gap-closer per se, since `reviewed-deps.json` already blocks the build | Self-hosted service; installs point at it instead of `registry.npmjs.org` |
| **Google OSS Rebuild** *(not on the original list, added because it directly answers gap 3/4)* | Automatically infers a build definition for an npm/PyPI/crates.io package, rebuilds it, semantically compares (normalizing timestamps/ordering) to the published artifact, and republishes the result as SLSA Build Level 3 provenance; a 2026 FOSDEM update added a network proxy to catch builds that phone home unexpectedly | Free, OSS, Google Open Source Security Team | **3** (proves a minified/bundled artifact's *meaningful content* matches an inferred build from source, even when a human can't read the bundle) and **4** (this is exactly "does the tarball match the claimed source" — Google explicitly built it because "`package-lock.json` and `npm ci` confirm a tarball hasn't changed since publication, but say nothing about whether it matches any particular source commit") | Go CLI; can consume/produce attestations; self-hostable |
| **Intrinsic Package Diff / `npm diff`** | Purpose-built tarball-vs-tarball (or tarball-vs-repo) diffing: shows exactly what changed in the *published* code between two versions of a package, independent of what the GitHub repo shows (the classic case: `event-stream`'s malicious payload was never visible in the GitHub-visible diff) | Free, hosted tool (`diff.intrinsic.com`) + npm's own built-in `npm diff` command | **1** (cheapest possible way to eyeball what actually changed in a version bump before re-approving it) and a manual assist for **4** | Web tool / CLI (`npm diff -- <pkg>@<v1> <pkg>@<v2>`) |
| **SonarQube (Advanced Security / ex-Tidelift)** — user specifically asked | **Sonar acquired Tidelift in December 2024.** Tidelift's maintainer-funding subscription (paying upstream maintainers directly) still operates today as its own subscription product. Separately, Sonar folded Tidelift's SCA technology into "**SonarQube Advanced Security**" (GA March 2025): dependency vulnerability ID, license compliance, SBOM generation, and malicious-package detection, gated behind paid Developer/Enterprise self-hosted editions (LOC-priced: Developer ≈$720–2,500/yr, Enterprise custom, Data Center ≈$100k/yr — sources vary) or SonarQube Cloud | Commercial (Sonar); Tidelift's maintainer-payment product is a separate, additional subscription | **6** (malicious-package detection, though not independently benchmarked against Socket/Sonatype in the sources found), **2** loosely (Tidelift's model is literally "verified insights from the maintainer," a different mechanism than a repo-health score) | Self-hosted server or SonarQube Cloud; CI plugin; would only make sense here if strape were already running SonarQube for first-party SAST, which it isn't (see §4) |

## 3. Status corrections found during this research (read this before trusting the list above)

- **Snyk Advisor is being sunset in January 2026** and folded into static `security.snyk.io` package pages —
  it stops being a live, queryable signal. Any plan built around "check Snyk Advisor's score" needs to move
  to deps.dev + OpenSSF Scorecard instead, which is strictly better anyway (broader ecosystem coverage,
  free API, no sunset risk announced).
  [Snyk Advisor alternatives writeup](https://scanner.blacksight.io/blog/snyk-advisor-alternatives),
  [Snyk package health score explainer](https://safeguard.sh/resources/blog/how-snyk-advisors-package-health-score-weighs-popularity-maintenance-and-community-signals)
- **Phylum was acquired by Veracode in January 2025** and no longer exists as an independent product,
  company, or purchasable tool. Its malicious-package detection lives on only inside Veracode's SCA
  platform. [Veracode press release](https://www.businesswire.com/news/home/20250106967344/en/Veracode-Acquires-Phylum-Inc.-Technology-to-Transform-Software-Supply-Chain-Security)
- **Sonar acquired Tidelift in December 2024**, and Tidelift's SCA technology now ships as **SonarQube
  Advanced Security** (GA March 2025), not as a standalone "Tidelift" product for new customers; the
  original maintainer-payment subscription is reported as still operating in parallel.
  [Sonar/Tidelift press release](https://www.sonarsource.com/company/press-releases/sonar-to-acquire-tidelift/),
  [SonarQube Advanced Security](https://www.sonarsource.com/blog/announcing-sonarqube-advanced-security/)
- One item researched but **not confirmed**: a claim surfaced in an initial search that Sonatype acquired
  "Socket AI" technology in 2025 to power Repository Firewall's malware detection. A follow-up search found
  **no corroborating source** for any such acquisition — Sonatype's 2025 malware-detection improvements
  appear to be organic (its own research team + quarterly "Open Source Malware Index" reports), and
  Socket.dev is independently thriving in 2026 (a $60M Series C at a $1B valuation in May 2026). Treat the
  "Sonatype acquired Socket" claim as **unverified and likely incorrect** — it is not repeated in the table
  above.
- **npq** (the npm install-time vetting wrapper) is still actively maintained (pushed 23 Jul 2026 per the
  GitHub API), contrary to what its GitHub-star-to-recency ratio might suggest — it just has very little
  incremental value here (see §4).
- **GuardDog** is actively maintained by Datadog, with a 3.0 release in mid-2026 — not abandoned.
- **Chainguard Libraries'** free-for-all-languages window was explicitly time-boxed through 30 June 2026,
  which has already passed as of this research date; current pricing was not published and needs to be
  re-verified with Chainguard directly before assuming it's still free.

## 4. Recommended stack for strape

Context that shapes every recommendation below: **50 shipped packages**, already individually tarball-
reviewed by a human+LLM process, already gated by a fail-closed allowlist, already SHA-pinned everywhere
pinning is possible, maintained by a **small team** doing infrequent, deliberate upstream syncs rather than
continuous automated dependency churn. That combination means: (a) noise-reduction tools built for
thousands-of-dependencies enterprises (Endor Labs, Semgrep Supply Chain's reachability engine, full Sonatype
Lifecycle) solve a problem strape doesn't have, and (b) registry-proxy control points (Sonatype/JFrog
Curation, Verdaccio) duplicate a guarantee `reviewed-deps.json` already provides for free. What's actually
missing is *cheap, continuous, behavior- and health-aware signal on a small, known set of packages* — which
is a good match for free/cheap tools, not enterprise platforms.

### Adopt now — free or cheap, high value

1. **Socket.dev** (free tier if the repo is public; Team tier ~$25/dev/mo otherwise). Closes gaps 1, 2, and
   6 more directly than anything else evaluated — it is specifically built to alert when an
   *already-approved* package's *new version* gains a capability it didn't have before, which is the exact
   shape of gap 1 and of the real 2025-2026 attacks (chalk/debug, Shai-Hulud, tanstack). Wire it in as a
   PR-time gate and let it re-scan on every upstream sync.
2. **OpenSSF Scorecard** (free). Closes gap 2 directly and cheaply — replaces the fully-manual judgment
   calls behind `high-scrutiny.json` with a reproducible, re-runnable score per dependency's upstream repo.
   Run it against each of the 50 packages' repos at review time and again at each upstream sync; a dropped
   score (branch protection removed, maintainer count down to 1, a new dangerous workflow pattern) is a
   trigger to add/keep a package in `high-scrutiny.json`.
3. **deps.dev API** (free, no infra). A drop-in data source for the same review process — it already
   surfaces the Scorecard number per package plus license and advisory data, so a few lines in the existing
   review tooling get this for free without even running Scorecard yourself.
4. **Datadog GuardDog** (free CLI). Run against each new/updated tarball before it's added to
   `reviewed-deps.json` — it is the closest OSS analog to what the project's own capability sweep does for
   first-party code, but pointed at third-party tarballs, closing part of gap 1 (point-in-time
   capability/threat correlation) and gap 6 (typosquat/obfuscation heuristics) at zero cost.
5. **GitHub Dependabot malware alerts + Dependency Review Action** (free). A cheap backstop layer:
   known-malware matching against the GitHub Advisory Database (now fed by OpenSSF's `malicious-packages`
   repo across 8 ecosystems) plus a PR-time license/package deny-list, and the built-in 3-day update
   cooldown directly blunts the worm-propagation window gap 6 worries about. This is strictly additive to
   osv-scanner, not a replacement.
6. **sigstore/cosign, targeted at the subset with npm provenance**. For the ~66 packages the baseline
   report already found have provenance attestations, add an explicit `cosign verify-blob-attestation` step
   instead of just checking presence — partial gap 4 coverage, free, a few lines of CI.
7. **Syft, as a second SBOM generator to diff against the custom one** (free). Not a new capability, but a
   correctness check on a hand-rolled, security-critical tool — cheap insurance against a bug or omission in
   the bespoke CycloneDX generator.
8. **StepSecurity Harden-Runner** (free for public repos). Hardens the CI pipeline that produces the SBOM,
   shrinkwrap, and reviewed-deps gate itself — a real gap in "SHA-pinned Actions," since a pinned action's
   *runtime* behavior isn't monitored, only its identity.

### Consider if budget/ops capacity exists

- **Chainguard Libraries for JavaScript** — genuinely the best available answer to gaps 3 and 4 together
  (rebuild-from-verified-source as proof of tarball↔source correspondence, and a hard refusal to build
  anything with an install script). Worth a spike to check how many of strape's 50 packages are even in its
  catalog (niche/young packages like `grok-mermaid` may not be) before paying for it, and its use would sit
  in tension with the existing "every package resolves from registry.npmjs.org" lockfile-hygiene rule —
  it'd need to be adopted as a parallel verification step, not a registry swap, unless that rule is
  revisited deliberately.
- **Sonatype Repository Firewall or JFrog Curation** — real proactive blocking with a published cooldown
  window and (for Sonatype) independently-verified fast detection, but both require standing up and
  operating a registry proxy (Nexus or Artifactory) purely to get a benefit `reviewed-deps.json` already
  delivers a different way (fail-closed on anything not explicitly reviewed). Reconsider if the team grows
  past reviewing every package by hand, or drops the manual-tarball-review practice in favor of automated
  throughput.
- **Aikido Security** — only makes sense if strape also wants SAST/secrets/DAST bundled under one bill;
  redundant with Socket for the npm-specific piece alone.
- **Google OSS Rebuild** — free, and directly targets gaps 3/4, but self-hosting/operating it (or depending
  on Google's own instance's coverage of strape's specific 50 packages) is a bigger lift than the "adopt
  now" tier; worth watching as it matures rather than adopting immediately.

### Not worth it here, and why

- **Snyk Open Source** — pure known-CVE SCA, fully redundant with npm audit + osv-scanner already in place;
  and its one differentiated free asset (Advisor) is being discontinued in January 2026 anyway.
- **Mend.io** — enterprise SCA + malicious-package detection that overlaps entirely with
  Sonatype/JFrog/Socket without a clearly differentiated capability for a 50-package closure; adds licensing
  overhead with no new gap closed.
- **Endor Labs / Semgrep Supply Chain's reachability engine** — reachability analysis exists to cut
  vulnerability-backlog noise on codebases with thousands of flagged CVEs; strape's already-trimmed,
  already-hand-reviewed 50-package closure doesn't have that noise problem. Revisit only if the closure
  grows an order of magnitude.
- **Trivy** — its npm/SBOM capability is a second implementation of exactly what osv-scanner and the custom
  SBOM generator already do; its unique value (container/IaC scanning) isn't relevant to an npm CLI project
  the way it's described here.
- **Verdaccio (or any self-hosted proxy) on its own** — the `reviewed-deps.json` build gate already
  provides "nothing unreviewed gets in" without the operational burden of running and securing a registry
  mirror. Only becomes worth it as infrastructure *for* one of the commercial curation products above, not
  as a standalone control.
- **Phylum** — moot; it no longer exists as a purchasable product (absorbed into Veracode, Jan 2025).
- **SonarQube Advanced Security (ex-Tidelift)** — its SCA/malicious-package feature set duplicates
  Socket/osv-scanner/the custom SBOM generator at a much higher price point (paid Developer/Enterprise
  self-hosted edition, LOC-priced), and would only be worth evaluating if strape were already paying for
  SonarQube for first-party SAST, which it currently is not (the project relies on its own capability sweep
  instead). The Tidelift maintainer-funding angle is a genuine, different lever — paying upstream
  maintainers improves the ecosystem strape depends on — but it doesn't produce an artifact strape's build
  pipeline can gate on, so it's a philosophical/budget decision, not a tooling one.
- **npq** — every individual heuristic it runs (age, popularity, install-script presence, README/LICENSE
  presence) is already exceeded by `min-release-age=2` and the `reviewed-deps.json` gate; it would only add
  value for an individual developer doing an ad hoc, off-process `npm install` outside the reviewed set —
  which the project's policy already discourages entirely.

## 5. What no tool here can do

This is the section that matters most for calibrating expectations: every tool surveyed above operates on a
**package manager's manifest, lockfile, tarball, or registry API**. None of them has any visibility into a
runtime `fetch()` call embedded in already-installed application code that reaches out to an *unrelated*
distribution channel.

**Gap 5 is the clean proof of this**, and it's not hypothetical for strape: pi resolves `ripgrep`/`fd`
versions from GitHub's release API at runtime and executes the downloaded binaries with no pinning or
verification (`utils/tools-manager.ts:108-123`, `:265-271`, per `strape/research/README.md`). This research
independently confirmed, live, that `ripgrep`'s own GitHub releases ship `.sha256` checksum files but
**no GitHub Artifact Attestation** (`gh api repos/BurntSushi/ripgrep/attestations/subject/sha256` returns
`404`) — meaning even `cosign`/`slsa-verifier`, the most relevant tools on this entire list for provenance
verification, would find nothing to check even if someone pointed them at it. Every SBOM generator, SCA
tool, registry proxy, and malware feed evaluated here rates a project "clean" while this exact path fetches
and runs an unverified native binary on first use, because none of them look outside the npm dependency
graph at all. The only correct answer, and the one strape already built, is `scripts/provision-tools.mjs`
pinning an exact version, verifying a checksum, and refusing on mismatch — a bespoke control, not a
gap a vendor tool fills.

Other things that remain irreducibly manual or LLM-assisted, not tool-closeable:

- **Actually reading a Tier C artifact.** No tool *understands* what a prebuilt native `.node` addon or a
  WASM blob (e.g. `@silvia-odwyer/photon-node`) does; the best available proxies are (a) trusting a
  rebuild-from-source pipeline like Chainguard Libraries or Google OSS Rebuild if and only if the package is
  in scope for one, or (b) coarse dynamic-analysis capability flags (Socket, GuardDog) that say "this touches
  the network" without saying *why* or *whether that's expected*. Neither substitutes for a human deciding
  whether the risk is acceptable for this product.
- **The "allow" verdict itself.** `reviewed-deps.json` requires a human name in `reviewedBy`, on purpose.
  Scorecard, Socket's scores, npq's heuristics, and every "health score" in this table are correlational
  trust proxies, not proof — a well-resourced, targeted compromise of a specific high-value dependency could
  present clean scores on every axis while still being malicious. No tool assigns accountability for that
  residual risk; a person has to.
- **Escalation engineering decisions.** Whether to vendor `grok-mermaid`, replace `proper-lockfile` with
  `fs` primitives, or drop image-attachment support to remove `photon-node` entirely (all live entries in
  `strape/audit/high-scrutiny.json`) are product/engineering trade-offs no scanner makes for you — tools can
  surface that a package is thin-trust, but the response is always a human call.
- **Cross-checking that a tool's own absence-of-signal is meaningful.** Most npm packages still don't
  publish provenance at all (per Sigstore's own 2026 commentary), so "no provenance" has to be read as a
  risk factor to weigh, not a pass/fail gate — another judgment call, not an automatable one.

## 6. Integration snippets — "adopt now" tools only

### OpenSSF Scorecard (GitHub Action, weekly + on push)

```yaml
name: Scorecard analysis workflow
on:
  push:
    branches: [main]
  schedule:
    - cron: '30 1 * * 6'

permissions: read-all

jobs:
  analysis:
    name: Scorecard analysis
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      id-token: write
    steps:
      - name: Checkout code
        uses: actions/checkout@<pinned-sha> # v4.x
        with:
          persist-credentials: false
      - name: Run analysis
        uses: ossf/scorecard-action@<pinned-sha> # v2.x
        with:
          results_file: results.sarif
          results_format: sarif
          publish_results: true
      - name: Upload to code-scanning
        uses: github/codeql-action/upload-sarif@<pinned-sha>
        with:
          sarif_file: results.sarif
```

To pull the same signal without running an Action at all (useful for scoring the 50 *dependency* repos, not
strape's own repo), query deps.dev directly, e.g. for a hypothetical dependency:

```bash
curl -s "https://api.deps.dev/v3alpha/systems/npm/packages/<name>/versions/<version>" | jq '.'
```

### Datadog GuardDog (per-package tarball scan, run before adding to reviewed-deps.json)

```bash
pip install guarddog   # or: uvx guarddog npm scan <package>

# Scan one candidate/updated package:
guarddog npm scan <package-name> --output-format=json

# Bulk-scan everything currently in the lockfile:
guarddog npm verify package-lock.json
```

### GitHub Dependabot malware alerts + Dependency Review Action

Enable malware alerts once, in repo Settings → Code security → Dependabot alerts (or via the enterprise/org
toggle) — no YAML needed. For PR-time license/package gating:

```yaml
name: Dependency Review
on: [pull_request]

permissions:
  contents: read

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/dependency-review-action@<pinned-sha> # v4.x
        with:
          fail-on-severity: moderate
          allow-licenses: MIT, Apache-2.0, BSD-3-Clause, ISC
```

### sigstore/cosign — verify npm provenance for packages that publish it

```bash
PKG=semver
VER=7.6.3

curl -s "https://registry.npmjs.org/-/npm/v1/attestations/${PKG}@${VER}" \
  | jq '.attestations[] | select(.predicateType=="https://slsa.dev/provenance/v1").bundle' \
  > npm-provenance.sigstore.json

cosign verify-blob-attestation \
  --bundle npm-provenance.sigstore.json \
  --new-bundle-format \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  --certificate-identity-regexp="^https://github.com/<expected-org>/<expected-repo>/.github/workflows/.*\.yml.?" \
  "${PKG}-${VER}.tgz"
```

If a package has no provenance at all, this step is skippable but should be logged as a recorded risk
factor for that package, not silently ignored.

### Syft — independent SBOM cross-check against the custom generator

```bash
syft packages:packages/coding-agent -o cyclonedx-json=syft-sbom.json
# then diff component name@version sets against strape's own generated SBOM:
diff <(jq -r '.components[] | "\(.name)@\(.version)"' syft-sbom.json | sort) \
     <(jq -r '.components[] | "\(.name)@\(.version)"' strape/audit/sbom-v0.84.0.json | sort)
```

### StepSecurity Harden-Runner — first step of every CI job

```yaml
steps:
  - name: Harden Runner
    uses: step-security/harden-runner@<pinned-sha> # v2.x
    with:
      egress-policy: audit   # switch to `block` with an explicit allowlist once the baseline is known
  - uses: actions/checkout@<pinned-sha>
  # ...rest of job
```

### Socket.dev — CI scan gate

```bash
# One-time: install the Socket GitHub App (https://github.com/apps/socket-security) for PR comments,
# or run the CLI directly in CI:
npx socket scan create --report --repo="$GITHUB_REPOSITORY" --branch="$GITHUB_REF_NAME" .
# Exit code 0 = passed policy, 1 = a package tripped the security/license policy.
# Confirm current CLI installation/auth steps against https://docs.socket.dev before wiring into CI,
# since exact flags are actively evolving.
```

## Sources

- [Socket.dev pricing](https://socket.dev/pricing) · [Socket for GitHub docs](https://docs.socket.dev/docs/socket-for-github) · [Socket security policy defaults](https://docs.socket.dev/docs/security-policy-defaults) · [Socket dependency overview blog](https://socket.dev/blog/introducing-dependency-overview-comments)
- [Snyk Advisor alternatives](https://scanner.blacksight.io/blog/snyk-advisor-alternatives) · [Snyk package health score explainer](https://safeguard.sh/resources/blog/how-snyk-advisors-package-health-score-weighs-popularity-maintenance-and-community-signals)
- [GitHub: Dependabot now detects malware in npm dependencies](https://github.blog/changelog/2026-03-17-dependabot-now-detects-malware-in-npm-dependencies/) · [Dependabot alerts on malicious packages across more ecosystems](https://github.blog/changelog/2026-07-28-dependabot-alerts-on-malicious-packages-across-more-ecosystems/) · [GitHub Dependabot cooldown](https://www.helpnetsecurity.com/2026/07/27/github-dependabot-cooldown/) · [actions/dependency-review-action](https://github.com/actions/dependency-review-action) · [Dependency review config docs](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/customizing-your-dependency-review-action-configuration)
- [OpenSSF Scorecard](https://scorecard.dev/) · [ossf/scorecard](https://github.com/ossf/scorecard) · [ossf/scorecard-action](https://github.com/ossf/scorecard-action) · [scorecard-analysis.yml example](https://github.com/ossf/scorecard/blob/main/.github/workflows/scorecard-analysis.yml)
- [deps.dev API announcement](https://security.googleblog.com/2023/04/announcing-depsdev-api-critical.html) · [deps.dev](https://github.com/google/deps.dev) · [osv-scanner license scanning via deps.dev](https://osv.dev/blog/posts/introducing-license-scanning-with-osv-scanner)
- [Sonatype Repository Firewall enhancements](https://www.sonatype.com/press-releases/sonatype-expands-open-source-malware-protection) · [Sonatype pricing](https://www.sonatype.com/products/pricing) · [Sonatype IQ 2026 review](https://safeguard.sh/resources/blog/sonatype-iq-2026-firewall-evolution-review) · [Sonatype Open Source Malware Index Q4 2025](https://www.sonatype.com/blog/open-source-malware-index-q4-2025-automation-overwhelms-ecosystems) · [Sonatype Guide announcement](https://www.opensourceforu.com/2025/12/sonatype-guide-tackles-ai-package-hallucinations-with-live-open-source-intelligence/)
- [JFrog Curation](https://jfrog.com/curation/) · [JFrog malicious package detection docs](https://docs.jfrog.com/security/docs/malicious-package-detection) · [JFrog Curation announcement](https://jfrog.com/blog/software-supply-chain-security-with-jfrog-curation/)
- [Mend.io SCA](https://www.mend.io/sca/) · [Mend malicious packages docs](https://docs.mend.io/platform/latest/malicious-packages-in-mend-sca) · [WhiteSource → Mend rebrand](https://www.mend.io/blog/whitesource-is-now-mend/)
- [Endor Labs reachability](https://www.endorlabs.com/learn/introducing-the-openssf-scorecard-api) · [Endor Labs 2026 review](https://appsecsanta.com/endor-labs) · [Endor Labs Gartner Hype Cycle 2026](https://www.endorlabs.com/learn/endor-labs-named-in-the-2026-gartner-r-hype-cycle-tm-for-secure-software-engineering)
- [Veracode acquires Phylum](https://www.businesswire.com/news/home/20250106967344/en/Veracode-Acquires-Phylum-Inc.-Technology-to-Transform-Software-Supply-Chain-Security)
- [Datadog GuardDog](https://github.com/DataDog/guarddog) · [GuardDog 3.0 announcement](https://securitylabs.datadoghq.com/articles/guarddog-3-0-release/) · [OpenSSF post on GuardDog](https://openssf.org/blog/2025/03/28/guarddog-strengthening-open-source-security-against-supply-chain-attacks/) · [Datadog malicious-software-packages-dataset](https://github.com/datadog/malicious-software-packages-dataset)
- [npq](https://github.com/lirantal/npq)
- [Trivy SBOM docs](https://trivy.dev/docs/latest/target/sbom/)
- [Grype](https://github.com/anchore/grype) · [Syft](https://anchore.com/syft/) · [Anchore OSS](https://anchore.com/opensource/)
- [Sigstore cosign npm provenance verification](https://blog.sigstore.dev/cosign-verify-bundles/) · [slsa-verifier](https://github.com/slsa-framework/slsa-verifier)
- [StepSecurity Harden-Runner](https://github.com/step-security/harden-runner) · [StepSecurity pricing](https://www.stepsecurity.io/pricing)
- [Semgrep Supply Chain](https://www.merito.com/vendors/semgrep/supply-chain) · [Semgrep pricing](https://aicodereview.cc/blog/semgrep-pricing/)
- [Aikido Security malware detection](https://www.aikido.dev/protect/malware-detection-in-dependencies) · [Aikido pricing (G2)](https://g2.com/products/aikido-security/pricing)
- [Chainguard Libraries for JavaScript](https://www.chainguard.dev/libraries/javascript) · [Chainguard mitigating npm malware study](https://www.chainguard.dev/unchained/mitigating-malware-in-the-npm-ecosystem-with-chainguard-libraries) · [Chainguard free-until-June-2026 announcement](https://www.chainguard.dev/unchained/chainguard-libraries-is-now-free-until-june-30-2026-no-commitment-required)
- [Verdaccio](https://www.verdaccio.org/)
- [Google OSS Rebuild announcement](https://blog.google/security/introducing-oss-rebuild-open-source/) · [OSS Rebuild site](https://oss-rebuild.dev/) · [Reproducible builds in language package managers, 2026](https://nesbitt.io/2026/02/24/reproducible-builds-in-language-package-managers.html)
- [Intrinsic Package Diff](https://diff.intrinsic.com/) · [npm diff docs](https://docs.npmjs.com/cli/v8/commands/npm-diff/)
- [Sonar to acquire Tidelift](https://www.sonarsource.com/company/press-releases/sonar-to-acquire-tidelift/) · [SonarQube Advanced Security announcement](https://www.sonarsource.com/blog/announcing-sonarqube-advanced-security/) · [SonarQube 2026 pricing breakdown](https://dev.to/rahulxsingh/sonarqube-pricing-in-2026-community-developer-enterprise-and-cloud-costs-explained-bdg) · [Tidelift maintainer payment docs](https://support.tidelift.com/hc/en-us/articles/4406294816916-How-we-pay-lifters)
- [Shai-Hulud V2 / Mini Shai-Hulud analysis, Microsoft](https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/) · [Shai-Hulud V2 analysis, Zscaler](https://www.zscaler.com/blogs/security-research/shai-hulud-v2-poses-risk-npm-supply-chain)
