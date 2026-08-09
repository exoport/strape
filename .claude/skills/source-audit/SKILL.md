---
name: source-audit
description: Run strape's first-party source security review — full audit at a new upstream pin, or diff-mode review of an upstream bump. Use when adopting a new pi release, when strape/audit/review-<tag>.md must be produced, or when asked to security-review the harness source. Produces a capability map plus adversarially verified findings.
---

# strape source audit

Two modes. Pick by asking: is there already a `strape/audit/review-<pin>.md` for the current
`strape/audit/UPSTREAM_PIN`?

- **No** → **full mode** (~29 agents, ~40 min, several million tokens). Only for a new baseline.
- **Yes** → **diff mode** (~4-8 agents, ~10 min). The normal monthly path.

Never skip the deterministic sweep in either mode: agents that grep for themselves miss sites, and their
coverage cannot be re-verified later.

## Threat model (use verbatim in every agent prompt)

- **T1 malicious repository content** — files, `CLAUDE.md`/`AGENTS.md`, skills, `.strape/settings.json` in a
  repo the user opens. Prompt injection is unmitigated by upstream design, so the only useful question is:
  *what can injected text make the harness DO with no human approval?*
- **T2 malicious model output** — OpenAI/xAI returning tool calls crafted to escape the workspace,
  exfiltrate secrets, or gain persistence.
- **T3 local unprivileged attacker** — predictable temp paths, races, file modes, symlinks.
- **T4 secret exfiltration** — API keys / OAuth tokens into logs, session files, HTML exports, telemetry,
  prompts, or child-process environments.
- **T5 runtime supply chain** — the harness npm-installing extensions/skills, or loading code from disk.

**Seed every review agent with upstream's own CVE history** (all fixed in 0.79.0; hunt variants and
regressions, this is the highest-yield instruction available):

| CVE | Class |
|---|---|
| CVE-2026-54325 | extension loading without user approval |
| CVE-2026-54328 | predictable temp install paths → local privesc |
| CVE-2026-54326 | XSS in HTML session export |
| CVE-2026-54327 | `auth.json` write race exposing tokens |

## Step 1 — deterministic sweep (always, no AI)

```sh
node strape/scripts/capability-sweep.mjs                                        # human summary
node strape/scripts/capability-sweep.mjs --json strape/audit/capability-sweep-<pin>.json
```

Classes: `process-exec`, `dynamic-code`, `network`, `fs-write`, `credentials`, `env`, `temp-paths`,
`deserialize`, `trust`. Regex-based: expect false positives (agents must dismiss them *explicitly*, in
writing) and misses through indirection (agents must add what they find by reading).

Optional but recommended external tools, if installed — they find taint flows regex cannot:

```sh
semgrep --config p/typescript --config p/nodejs --config p/security-audit --config p/secrets \
        --sarif -o strape/audit/semgrep-<pin>.sarif packages/coding-agent/src packages/ai/src packages/agent/src
```

## Step 2 — full mode: capability map, 12 parallel agents (sonnet)

One agent per area, each writing `strape/audit/capability-map/<slug>.md` and returning a structured summary.
Areas: `cli-entry`, `core-tools`, `core-extensions`, `core-a`, `core-b`, `core-subsystems`, `utils`,
`interactive-a`, `interactive-b`, `ai-openai-xai`, `agent-core`, `tui`.

Each section must contain: scope + LOC; one prose paragraph of what the area can do; a capability table
(`file:line | what | trigger | guard | attacker-influenced?`); **dismissed sweep hits with reasons**;
capabilities the sweep missed; questions for the human reviewer.

The point of this phase is that a human signs off on *one page per area* instead of reading 70k LOC — so
"trigger" and "guard" columns are mandatory. A capability with no guard is the finding.

## Step 3 — full mode: threat review, 8 agents (opus, effort high)

Hot paths, one agent each, pipelined into verification (do not barrier):

| slug | scope |
|---|---|
| `tool-exec` | bash tool, every `process-exec` site: shell vs argv, approval gate bypasses, inherited env (T4) |
| `tool-fs` | read/write/edit/glob/grep: workspace containment, symlinks, `~/.ssh`, `auth.json`, persistence via `.git/hooks`, TOCTOU, file modes |
| `extensions` | what executes JS/TS from disk; is approval content-keyed or path-keyed; jiti sandboxing (none — confirm and state impact) |
| `package-manager` | runtime npm invocations, registry override, `--ignore-scripts`, temp path predictability, does `PI_OFFLINE` fail closed |
| `trust-auth` | trust persistence and every path to "trusted" without a human yes; `auth.json` atomicity, mode 0600, race, token logging |
| `session-export` | HTML escaping of model output and file content; script/srcdoc/`on*` sinks; secrets in session files; share/upload gating |
| `net-secrets` | baseURL override → key exfiltration; keys in logs/errors; TLS verification; SSE parsing on hostile input; proxy env interception |
| `context-skills` | what loads with no trust approval, how far up the tree; **is `allowed-tools` enforced** (it is not — verify and state the consequence for reusing `~/.claude/skills`); DoS limits; symlink escapes |

Require of every agent: a concrete attack path (what the attacker controls → what they do → what they get),
quoted evidence with `file:line`, **and** `assurance_notes` for things checked and found sound. A review that
only lists problems is not evidence of coverage. Empty findings is a valid result — say so rather than invent.

Severity baseline: a developer running strape on their own workstation, prompt injection possible, no sandbox.
Anything upstream documents as accepted risk is `info` unless there is a bypass needing no user approval.

## Step 4 — adversarial verification (mandatory)

One skeptic agent per finding, default verdict REFUTED, prompted to *refute*. Refute when: the missed guard
actually exists; the input is not attacker-controllable; the path needs a human approval the finding glossed
over; the severity assumes a capability the code lacks; or it restates accepted risk with no novel bypass.
CONFIRMED requires the verifier personally traced every step. Keep REFUTED findings in the record with
reasons — nothing may silently vanish.

### Freeze the tree, or verification lies to you

**Do not apply fixes while a review pass is running.** A review measures one commit; changing the subject
mid-measurement corrupts the record.

> This happened. Hunk 7 was written while the v0.84.0 review was still in flight, and two verifiers then
> "refuted" the pre-trust settings finding (hunk 7) on the grounds that "the code the claim describes does not exist in this tree",
> each citing the fix commit. They were right about the tree and wrong about the vulnerability. In substance it
> was corroboration — two agents independently confirmed the fix works — but as a *verdict* it was wrong, and
> a later reader would conclude the finding was never real.

Two rules follow:

1. Batch fixes until the pass completes, or re-run verification for anything you touched.
2. Give verifiers a fourth verdict, **`FIXED_IN_STRAPE`**, and tell them explicitly to read
   `strape/docs/HUNKS.md` first and use it when a hunk already closed the issue. `REFUTED` means "never real";
   `FIXED_IN_STRAPE` means "real, and we closed it". Conflating them loses the reason the hunk exists — and the
   next person deletes the hunk.

### Verdict coverage is a number you must report

Count unique findings by id (a resumed workflow replays cached results, so raw journal lines double-count) and
state how many have no verdict. An unverified finding is not a refuted one. If a rate limit or crash kills
verifier agents, the honest summary is "N verified, M unverified", never "N findings".

## Step 5 — write the record

- `strape/audit/capability-map-<pin>.md` — executive capability statement, all externally-reachable
  capabilities with guards, the network endpoint list with which are killed by `PI_OFFLINE=1`, links to sections.
- `strape/audit/review-<pin>.md` — scope + declared out-of-scope with justification; method (models named);
  findings by corrected severity; REFUTED list; accepted-risk register; hardening split into
  "settings/launcher (free)" vs "needs a new hunk (costly)"; **coverage limitations**; sign-off block.

Then baseline the sweep so future drift is visible:
`node strape/scripts/capability-sweep.mjs --json strape/audit/capability-sweep-<pin>.json`

## Diff mode (the monthly path)

```sh
PIN=$(cut -d' ' -f1 strape/audit/UPSTREAM_PIN)
git diff $PIN..<target> --stat -- packages/coding-agent/src packages/ai/src packages/agent/src packages/tui/src
node strape/scripts/capability-sweep.mjs --check strape/audit/capability-sweep-$PIN.json
```

1. If the sweep drift check passes and no file in the step-3 hot-path table changed → one agent reviews the
   whole diff, and the review record is a short delta appended to a new `review-<target>.md`. Say plainly
   that no hot path changed.
2. If a hot path changed → one opus agent per changed hot path, reviewing **the diff with surrounding
   context**, plus adversarial verification. Reuse the step-3 prompts.
3. New capability sites or new hosts from the drift check are findings until reviewed and explained.
4. `/security-review` on the merge branch is a useful extra pass, not a replacement.

## Rules

- Read-only: never let a review agent modify anything under `packages/`. Audit artifacts only.
- Cite `file:line` for every claim; a claim without a citation is not a finding.
- Prefer more, smaller agents over fewer huge ones — a 20k-LOC area gets skimmed, a 3k-LOC area gets read.
- Concurrency is capped at `min(16, cores-2)`; on an 8-core box that is 6, which is also rate-limit friendly.
- Record the model used per phase in the review record. Reviews are evidence; evidence needs provenance.
