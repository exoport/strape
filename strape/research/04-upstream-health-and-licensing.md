# Upstream Health, Licensing, and Security History

This file answers: how active and healthy is the `earendil-works/pi` project, what does its MIT license
actually permit for a rebranded fork, what does the contributor policy mean for ever upstreaming strape's
patches, what were the four disclosed CVEs and what do they say about the trust model, and what does the
historical evidence from real community forks say about rebranding risk. Evidence is drawn from
`02-pi-dev-upstream.json`, whose findings are explicitly a mix of live-verified API/registry calls (marked
below) and WebSearch-sourced claims that were **not** independently re-verified by that report's own
admission — that distinction is preserved throughout this file. Nothing in this file was independently
re-run in this pass beyond spot-checking file citations already covered in other research files; live
counts (star counts, release timestamps) are stated as of the raw report's capture and are not re-fetched
here.

## 1. Repo health and release cadence

**Verified via live GitHub REST API call** (`api.github.com/repos/earendil-works/pi`, run by the
02-pi-dev-upstream.json research pass): 84,810 stars, 10,504 forks, 92 open issues, created 2025-08-09, last
push 2026-08-06 (the same day as this research). License field: MIT.

**Release cadence, verified via `api.github.com/repos/earendil-works/pi/releases`**: v0.84.0 published
2026-08-06T11:07:05Z, v0.83.0 on 2026-07-29, v0.82.1/v0.82.0 on 2026-07-25/24, v0.81.1/v0.81.0 both on
2026-07-21, v0.80.10/.9/.8 all between 2026-07-14 and 2026-07-16 — roughly **2-5 releases per week**,
sometimes multiple same-day patch releases. This cadence is the direct justification, in every downstream
design proposal, for **not** tracking head: syncing at a monthly or on-demand cadence means deliberately
sitting 1-4 weeks behind, which the security-first design treats as the acceptable cost of a gated review
process rather than a deficiency.

Breaking changes do occur inside this cadence with documented changelog notes — e.g., v0.80.7 renamed
`sendSessionIdHeader` to `sessionAffinityFormat` (02-pi-dev-upstream.json risks #2) — meaning any fork that
patches source files (as opposed to using only `piConfig` + `settings.json` + SDK/extension hooks) must
budget recurring re-test time after every adopted release.

## 2. License

The repository's `LICENSE` file (`github.com/earendil-works/pi/blob/main/LICENSE`, fetched and read
directly by the research pass, i.e. verified by reading the actual file, not just WebSearch) is **plain
MIT**, Copyright (c) 2025 Mario Zechner — no Fair Source/BSL clauses in the core repo. This is permissive
enough for renaming, rebranding, and redistributing under a new name, provided the MIT notice is retained.

**Caveat, sourced only from WebSearch summaries and explicitly flagged by the report as not independently
verified**: an "open-core RFC 0015" business model is referenced, under which Earendil may license
future/commercial components differently from the MIT core. The report could not verify this on
`rfc.earendil.com` in its pass. The practical implication for strape: do not assume every future
`earendil-works`-namespaced package is MIT just because the currently-used core packages
(`pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `pi-telemetry`, `pi-protocol`, `pi-client`) are —
check the license of any new Earendil dependency explicitly before adopting it.

## 3. Contributor policy and what it means for upstreaming strape's patches

`CONTRIBUTING.md` (fetched from `raw.githubusercontent.com/earendil-works/pi/main/CONTRIBUTING.md`, i.e.
read directly, not summarized secondhand) states: **"All issues and PRs from new contributors are
auto-closed by default."** A maintainer must reply `lgtmi` (future issues, not PRs, are no longer
auto-closed) or `lgtm` (future issues *and* PRs are no longer auto-closed) before a PR will even be
reviewed. PRs opened without a prior `lgtm` are closed unread. This is enforced by CI workflows confirmed
present in the local clone: `issue-gate.yml`, `pr-gate.yml`, `approve-contributor.yml`,
`issue-triage-labels.yml`, `issue-analysis.yml`.

`CONTRIBUTING.md` additionally states: **"If your feature does not belong in the core, it should be an
extension. PRs that bloat the core will likely be rejected."**

**Implication for strape**: any of strape's six hunks (see `strape/research/05-design-alternatives.md`) that
someone might wish to upstream would need to first go through an issue (not a PR), earn `lgtm` from a
maintainer, and *still* risk rejection as "core bloat" even after that gate — since branding/provider-trim
changes are, by definition, fork-specific and not something upstream's own userbase needs. Every design
pass and the final proposal treat this as settled: the six hunks are carried forever, and nobody is
attempting to upstream them. `strape-proposal.md` Open Question #9 explicitly asks the team to "confirm
nobody is planning to upstream them," rather than assuming it.

## 4. The four 2026-06-08 CVEs

Four published GitHub Security Advisories exist for `@earendil-works/pi-coding-agent`, all disclosed
2026-06-08 (**verified via live API call** to `api.github.com/repos/earendil-works/pi/security-advisories`,
cross-checked against the GitLab Advisory Database by the research pass):

| GHSA | CVE | Severity | Issue | Fixed in |
|---|---|---|---|---|
| GHSA-mqxh-6gq7-558m | CVE-2026-54325 | Medium | Project-local extensions loaded without approval | 0.79.0 |
| GHSA-jfgx-wxx8-mp94 | CVE-2026-54328 | High | Predictable temp extension install paths → local privilege escalation | 0.78.1 |
| GHSA-7v5m-pr3q-6453 | CVE-2026-54326 | Low | XSS in HTML session export via Markdown URL sanitization bypass (reported by CrowdStrike researchers) | 0.78.1 |
| GHSA-r95r-rj6r-c39x | CVE-2026-54327 | Low | Race condition in `auth.json` writes could transiently expose API keys/OAuth tokens (also CrowdStrike) | 0.78.1 |

The local/mirrored clone and the strape fork are both pinned to v0.84.0, which postdates all four fixes.
These four CVEs collectively **seed the initial security-review scope** that every downstream design
adopted: the strape proposal's audit scope (§7.3) explicitly lists "the extension loader/runner, the
npm-based extension/skill installer (`package-manager.ts`), project-trust (`trust-manager.ts`), and
`auth.json` handling" as priority read targets specifically *because* these are exactly the four areas
that produced these CVEs. The shipped `strape/audit/high-scrutiny.json` and `capability-sweep-v0.84.0.json`
files (confirmed present in the repo in this pass) operationalize this same seeded scope.

## 5. Security posture: no sandbox, by design

`docs/security.md` (fetched from `pi.dev/docs/latest/security`) states plainly: pi has **no built-in
sandbox** by design. "Built-in tools can read files, write files, edit files, and run shell commands with
the permissions of the pi process." The docs explicitly reject *partial* sandboxing as false security, and
instead recommend external containment: containerize/VM the whole process, route tool execution through
Gondolin-style micro-VMs, avoid mounting `~/.pi/agent`, use read-only mounts, and restrict network access.
**Prompt injection from untrusted content is explicitly out of scope for pi's own vulnerability program.**

Trust-model detail: project-local resources (`.pi/settings.json`, `.pi/extensions`, `.pi/skills`,
`.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.agents/skills`) require an explicit one-time trust decision
cached in `~/.pi/agent/trust.json`. Non-interactive modes (`-p`, `--mode json`, `--mode rpc`) skip the
prompt unless `defaultProjectTrust: "always"` is set — relevant to anyone planning headless/CI use of
strape. **Context files (`AGENTS.md`/`CLAUDE.md`) load regardless of trust status** — trust gates
extensions and skills, but not context-file content, which upstream's own `SECURITY.md` names an
unmitigated prompt-injection vector. This is the same fact independently confirmed by the code audits in
`strape/research/02-claude-compat-and-providers.md` §3, and it is the reason strape's own `CLAUDE.md` keeps
`defaultProjectTrust: "ask"` as a non-negotiable rather than relaxing it for convenience.

**Every design pass concluded the same thing about this gap**: strape's hardening work addresses the
supply chain (what code and dependencies can even be present to run), not pi's sandbox-free execution
model. Whether strape needs its own containerization layer is recorded as an explicit open question in
`strape-proposal.md` (§10, Open Question #2), not a decision — "does strape need containerisation..., or is
'same trust as Claude Code today' the accepted baseline?"

## 6. Known community forks and the real incomplete-rebranding bug

Per WebSearch, **not independently deep-verified** by the research pass: several community forks exist
that validate the `piConfig` rebrand mechanism in practice — `can1357/oh-my-pi`, `kingargyle/pi-fork`,
`elpapi42/pi-fork`, `HazAT/pi-config` (a dotfiles repo cloned to `~/.pi/agent/`).

One concrete, real bug report **was** checked: a live GitHub issue (`badlogic/pi-mono#3476`) documents a
real downstream rebrand hitting an incomplete-branding bug — a hardcoded `"Quit pi"` string that did not
use `APP_NAME`. This confirms, with a real-world example rather than just code inspection, that `piConfig`
rebranding works for the vast majority of user-facing strings but **not with 100% coverage** — a rebranding
fork should grep for residual hardcoded "pi"/"π" strings after setting `piConfig`, rather than assuming the
mechanism is exhaustive. This is exactly the class of bug strape's own hunk 3 (the `system-prompt.ts`
identity strings) was written to close before shipping, and the same caveat is recorded in
`strape/docs/HUNKS.md`'s discussion of hunk 1's limits.

## 7. Documentation lag from the pi-mono rename

Some upstream docs still contain stale cross-references to the pre-rename repo name "pi-mono":
`development.md` says `git clone https://github.com/earendil-works/pi-mono`, and an `AGENTS.md` link points
at a `.../pi-mono/...` URL. **Verified live** by the research pass: `https://github.com/earendil-works/
pi-mono` now returns an HTTP redirect ("Moved Permanently") to `earendil-works/pi` — confirming the
canonical repo today is `earendil-works/pi`, with minor, cosmetic documentation lag after the repo rename.
This has no bearing on strape's own fork mechanics; it is a cosmetic doc-freshness issue inherited passively
by anyone cloning upstream, not something strape's hunks touch or need to fix.
