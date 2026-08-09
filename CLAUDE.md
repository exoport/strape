# strape

A hardened, Grok/OpenAI/Gemini-only vendor fork of the [pi](https://pi.dev) agent harness. The point of the fork is to
own our own release gate: we choose which upstream tag we run and which dependencies ship, and we choose them
deliberately rather than tracking head. Anthropic models are out of scope — Claude Code covers those.

**Read `strape/docs/HUNKS.md` before editing anything under `packages/`.** That tree is upstream's; strape's
entire divergence is sixteen small hunks plus the additive `strape/` directory. Every extra line of divergence
is a merge conflict you will pay for at every upstream release. Hunk numbers are stable slots, not a sequence
— they are cited from `strape/audit/` and from comments in upstream source, so never renumber them.

## Layout

| Path | Owner | Rule |
|---|---|---|
| `packages/**` | upstream pi | sixteen approved hunks only; `verify-overlay.mjs` enforces them |
| `strape/audit/**` | strape | the release-gate record: review, baselines, SBOM, verdicts, attestation |
| `strape/research/**` | strape | how the fork was decided: architecture, alternatives weighed, tooling survey. Cited by `SECURITY-TOOLING.md`, `RELEASE-FLOW.md` and the `dep-review` skill |
| `strape/scripts/**` | strape | gates and tooling; zero npm dependencies, on purpose |
| `strape/bin/strape` | strape | launcher; sets the offline posture |
| `strape/runtime/**` | strape | fail-closed module guard |
| `.claude/skills/**` | strape | the review process, as runnable skills |

Branches: `vendor` = pristine upstream tags (never edit), `main` = vendor + hunks. Merge, never rebase.

## Non-negotiables

1. **Never install without `--ignore-scripts`.** `npm ci --ignore-scripts --no-audit --no-fund`.
2. **Never bypass the reviewed-deps gate** to unblock a build. A failing gate means a dependency has not been
   reviewed — that is the gate working. Review it (`.claude/skills/dep-review`) and record a verdict.
3. **Never build from an unreviewed upstream tag.** `strape/audit/UPSTREAM_PIN` names the reviewed tag; the
   sync playbook (`strape/scripts/sync.mjs`) is the only path to a new one.
4. **Never point `piConfig.configDir` at `.claude`.** It would put strape's `settings.json`, `auth.json`,
   `trust.json` and sessions inside the user's real Claude Code directory, colliding with a different schema
   at the same path (`core/settings-manager.ts:201`). strape uses `.strape` and reads Claude's files only.
5. **Never put a strape version in `package.json`.** 17 manifests carry a version, upstream bumps them in
   lockstep, and internal deps use `^` ranges — a strape version there means a ~17-file conflict every release
   and broken range resolution. Identity lives in `strape/VERSION` + `strape/audit/UPSTREAM_PIN` + the
   `strape-v*` git tag; see `strape/docs/RELEASE-FLOW.md`.
6. **Provider scope is OpenAI + xAI + Google Gemini.** Gemini goes through Google's OpenAI-compatible endpoint
   (declared in `models.json`, zero new dependencies) — **not** through pi's built-in `google` provider, whose
   `@google/genai` SDK stays dev-only. All five non-OpenAI provider SDKs remain dev-only (hunk 4) and blocked at
   runtime by `strape/runtime/deny-modules.mjs`; moving one back into `dependencies` is a dependency-review
   event, not a bug fix. Measured cost of the native Gemini SDK: 56 -> 93 shipped packages and 0 -> 2 with
   install scripts. See `strape/docs/HUNKS.md` hunk 4.

## Common commands

```sh
node strape/scripts/verify-overlay.mjs         # are all sixteen hunks intact?
node strape/scripts/rebrand-test.mjs           # hunks 3+10, asserted against real CLI output (needs a build)
node strape/scripts/trust-regression-test.mjs  # hunks 7+11, the project-trust boundary (needs a build)
node strape/scripts/agent-dir-perms-test.mjs   # hunk 12, ~/.strape is 0700 (needs a build)
node strape/scripts/redirect-guard-test.mjs    # hunk 13, cross-origin redirects refused (needs a build)
node strape/scripts/jiti-cache-test.mjs        # hunk 14, transpile cache out of /tmp (needs a build)
node strape/scripts/mermaid-throw-test.mjs     # hunk 15, a parser throw falls back to source (needs a build)
node strape/scripts/lock-stale-test.mjs        # hunk 16, a slow lock holder is not robbed (needs a build)
node strape/scripts/guarddog-gate-test.mjs     # the GuardDog gate fails when GuardDog does not run
npm ci --ignore-scripts --no-audit --no-fund
npm run build:offline                          # model catalog is vendored; no network needed
node strape/scripts/lockfile-audit.mjs         # registry/https/integrity/exact-pin hygiene
node strape/scripts/reviewed-deps.mjs --report # the build gate
node strape/scripts/capability-sweep.mjs       # what can this program do?
node strape/scripts/sbom.mjs                   # CycloneDX 1.6 of the shipped closure
node strape/scripts/high-scrutiny-check.mjs    # thin-trust packages unchanged?
node strape/scripts/sync.mjs --target v0.86.0  # stage A of an upstream adoption
./strape/bin/strape                            # run with the offline posture
strape/sandbox/strape-sandbox --init           # run contained (bubblewrap); see strape/docs/SANDBOX.md
```

`npm run check` (biome + tsgo) and `./test.sh` are upstream's and still work. Run the suite with the pinned
tools reachable, or 13 grep/find-tool tests fail for want of a binary and read as regressions — `test.sh`
isolates `HOME`, so the harness cannot see its own `<agentDir>/bin`:

```sh
node strape/scripts/provision-tools.mjs   # once: pinned, sha256-verified rg/fd
PATH="$(dirname "$(readlink -f "$(volta which node)")"):$HOME/.strape/agent/bin:$PATH" ./test.sh
```

## Security review

Two skills encode the process, and both work in full mode (new baseline) and diff mode (upstream bump):

- `.claude/skills/source-audit` — deterministic capability sweep → per-area capability map → opus threat
  reviews of the hot paths, seeded with upstream's own CVE classes → adversarial verification → written record.
- `.claude/skills/dep-review` — deterministic lockfile/audit/SBOM checks → tiered per-package review of the
  **shipped tarballs** (not the GitHub repos) → verdicts in `strape/audit/reviewed-deps.json`.

The written record and the capability map are in `strape/audit/` alongside the machine-readable baselines;
`strape/audit/README.md` explains what each file is and why the review is public.
Agent output is evidence for a human sign-off, never the sign-off itself: `reviewedBy`/`reviewedAt` stay null
until a person puts their name in.

## Working style here

- Cite `file:line` for claims about upstream behaviour. This repo's decisions were all made against verified
  code, and the next person needs to re-verify them after a merge.
- Prefer settings, the launcher, or an extension over a new hunk. Prefer deleting a feature over vendoring a
  dependency you cannot read.
- `strape/scripts/*` must stay dependency-free: a supply-chain tool must not enlarge the supply chain it
  measures.

## Where work happens: CI vs local

The split is not "some checks here, some there" — it is **local does the judging, CI proves the judging
happened and that nothing changed since**. `strape/scripts/review-attest.mjs` binds a named human sign-off to a
digest of the reviewed scope; CI verifies it and fails with *re-review required* if any reviewed file moved.
CI must never be able to write that attestation.

| Runs in CI | Runs locally |
|---|---|
| every deterministic gate, drift check and scanner | the LLM review passes (`source-audit`, `dep-review`) |
| `review-attest --verify` (the enforcement point) | `review-attest --record` (the sign-off itself) |
| `dep-health`, `provenance` (public APIs, no auth) | filling `reviewedBy` / `reviewedAt` |
| `socket-scan` (needs `SOCKET_API_KEY`) | `sync.mjs --target/--merge/--adopt`, `provision-tools --record` |

Release flow is **GitHub → local → GitHub**: CI detects (daily scanners), a human reviews and signs off
locally, CI verifies and releases. Full detail and rationale in `strape/docs/RELEASE-FLOW.md`; the remaining
account/settings steps are in `strape/docs/SETUP.md`.
