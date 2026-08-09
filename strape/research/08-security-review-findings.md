# Security review results — upstream pi v0.84.0

What the review actually found, what was fixed, what remains open, and where the review itself fell short.
Run 2026-08-06/07 against `strape` `main` (upstream tag `v0.84.0`) using the two layers described in
[06-security-review-methodology.md](06-security-review-methodology.md).

**Headline: the review paid for itself.** It found three issues serious enough to fix in code — one of them
sitting inside strape's own headline feature — plus a supply-chain hole that no npm tooling can see. It also
found a flaw in strape's own review tooling. Nine hunks of divergence now exist; **three of them are security
fixes the review produced**, not branding or dependency work.

---

## 1. Scale and outcome

| | Job A (source) | Job B (dependencies) |
|---|---|---|
| Scope | ~70k LOC across 4 packages, 454 files | 50 external packages in the shipped closure |
| Agents | 66 launched, 50 completed, then 16 re-run + a 17-agent backlog pass | 27, all completed |
| Tokens | ~5.3M | ~1.4M |
| Raw findings | **92 unique** (deduplicated across both runs; the first journal alone showed 45) | 50 verdicts |
| After verification | **63 verified** — 31+ confirmed, 8 refuted, 3 plausible; **29 low/info unverified**, no high or medium left unverified | 24 `allow`, 26 `escalate` |

Deterministic layer: **1628** capability sites over 454 files (1339 before the sweep's camelCase blind spot was fixed — HV-8); 0 npm advisories (dev and prod); 309/309 packages
with verified registry signatures (61 with provenance attestations); `osv-scanner` v2.4.0 clean on both the
416-package dev lockfile and the 56-package shipped closure.

---

## 2. Fixed in code

Three findings were fixed as hunks. Each was verified by reproduction before the fix and after, and each is
pinned by a CI test so a future upstream merge cannot silently revert it.

### STRAPE-2026-002 — symlinked project context file reads any file the user can read (hunk 8)

The most serious finding, and the one that matters most for strape: it lives in the `CLAUDE.md` path that is
strape's headline compatibility feature.

`statSync` follows symlinks, so upstream's `isFile()` guard passes for `CLAUDE.md -> ~/.ssh/id_rsa`. Context
files load with **no trust prompt**, and their content goes into the system prompt sent to the model provider.
So a cloned public repo containing one symlink exfiltrates the victim's private keys, `auth.json`, or cloud
credentials to a third-party API — with no tool call, no model cooperation, and no privileged action by the
user. Reproduced; fixed with `lstatSync`, allowing symlinks only in the agent dir where `claude-compat.mjs`
deliberately links `~/.claude/CLAUDE.md`. Adopting `CLAUDE.md` reuse without this fix would have meant
shipping the vulnerability as a selling point.

### Runtime installs executed lifecycle scripts (hunk 9)

`grep -c "ignore-scripts"` over `core/package-manager.ts` returned **0**. strape's entire build posture is
`--ignore-scripts` with an empty install-script allowlist — but extension and skill installs happen at
*runtime* through a different code path with no such flag, so a dependency's `postinstall` ran with the user's
privileges for a package that was never in the reviewed closure at all. The dependency gate, the SBOM and the
reviewed-deps allowlist all describe the build; none of them described this. Fixed in all four install-arg
builders (npm, pnpm, bun, git), each asserted separately in CI.

### STRAPE-2026-001 — untrusted project settings redirect the session transcript (hunk 7)

`main.ts:617` built the startup `SettingsManager` before trust was resolved, and `projectTrusted` defaults to
`true`, so a never-trusted repo's `.strape/settings.json` chose `sessionDir`. Reproduced end-to-end: the
transcript landed in an attacker-designated directory from a freshly `git init`ed repo. Worst case is an
in-repo path, where the victim's own `git add -A && git commit && git push` publishes their transcript — file
contents, command output, pasted secrets — to the attacker's repository. Fixed using the *persisted* trust
decision, so trusted projects keep the legitimate documented feature.

### Plus, outside npm entirely: unverified `rg`/`fd` binaries

`utils/tools-manager.ts` resolves versions from GitHub's *latest release* endpoint at runtime, downloads the
archives, and the binaries are spawned by the `grep`/`find` tools — with no checksum, signature, or pinned
version. Because rg and fd are **not npm packages**, the lockfile, shrinkwrap hashes, SBOM, `npm audit`,
`osv-scanner` and the reviewed-deps gate all report the project clean while a fresh install fetches and
executes unverified native code on first `grep`. Handled by `provision-tools.mjs` (pinned, sha256-verified,
refuse-on-mismatch) plus `PI_OFFLINE=1` in the launcher. This is the single best argument for doing a
capability sweep rather than only a dependency audit.

---

## 3. Confirmed but not fixed — the accepted-risk register

Confirmed by agents, left unfixed because each needs real upstream work or is upstream's documented design.
All are recorded so the team is choosing them rather than discovering them.

| Finding | Where | Why not fixed |
|---|---|---|
| `/reload` executes project extensions that appeared *after* the trust decision, and persists `trusted:true` silently | `resource-loader.ts:387`, `interactive-mode.ts:4652` | **Highest-severity open item.** Trust is per-directory and never re-confirmed when contents change. Fixing means re-prompting on resource change — an upstream design change |
| jiti writes transpiled extension code to world-shared `/tmp/jiti` with predictable names; poisoned cache entries execute | `extensions/loader.ts:444` | Local-privesc shape (CVE-2026-54328 sibling); lives in a dependency's cache behaviour |
| A repo-checked-in `.npmrc` steers the automatic startup `npm view` (cwd = project dir): registry redirect and env-var exfiltration via an Authorization header | `package-manager.ts:1486` | Needs an npm-invocation hardening pass; `PI_OFFLINE=1` closes the common path |
| `npmCommand` is merged from project settings, so a trusted repo chooses the argv strape spawns | `package-manager.ts:1721` | Requires treating settings as untrusted input generally |
| `/share` writes the full transcript to a fixed, world-readable `/tmp/session.html` | `interactive-mode.ts:5838` | Symlink-clobber and disclosure; don't use `/share` |
| HTML export interpolates `tokensBefore`/`exitCode` raw (session files parsed without validation) | `export-html/template.js:1297` | XSS in exported HTML, CVE-2026-54326 class |
| Full bash output spills to world-readable `/tmp` files that are never deleted | `core/tools/output-accumulator.ts:216` | Command output routinely contains secrets |
| `~/.strape/agent` created with ambient umask by four writers; `auth.json` mode fixed only after write, never for a pre-existing file | `auth-storage.ts:54` | Verified: `auth.json` is 0600 and the dir 0700 on this machine, but the guarantee is not enforced |
| Session transcripts written 0664 — safe only because the parent dir is 0700 | (HV-4) | Breaks if `sessionDir` is relocated |
| Model-supplied bash command rendered to the terminal without ANSI/control sanitisation (OSC 52 clipboard write, display spoofing) | `core/tools/bash.ts:230` | Terminal-level threat |
| Context-file discovery walks cwd→`/` with no trust gate and no repo boundary | `resource-loader.ts:148` | A world-writable ancestor (e.g. working under `/tmp`) can inject a *regular* context file. Hunk 8 only closed the symlink variant |
| `allowed-tools` skill frontmatter is documented but never parsed | `core/skills.ts` | **Directly relevant to `.claude/skills` reuse:** imported skills carry no capability limit. Reuse skills you wrote |
| Remote/persisted catalog entries can retarget a provider `baseUrl`, sending the key and conversation elsewhere | `remote-catalog-provider.ts:19` | `PI_OFFLINE=1` blocks the remote overlay; the persisted path remains |
| No sandbox; prompt injection unmitigated | by design | Upstream's documented posture. Containerise if you need the boundary |

Dependency side: 26 of 50 packages are `escalate`, not because they are malicious but because each carries a
question a human must answer. The material ones: **undici** (cross-origin 307/308 redirect replays the request
body — the adversarial pass proved this path is live on every model call; wants an origin allowlist or
`redirect: "error"`), **jiti** (adversarial pass *contradicted* the first pass: the babel-config lockout is
overridable via public `transformOptions.babel`), **grok-mermaid** (9-day-old single-maintainer package,
confirmed prototype-chain read reproduced by running its dist), **proper-lockfile** (time-based stale-lock
reclamation can hand two processes the same auth-file lock), **glob**/**path-scurry** (absolute-pattern and
realpath root escape — containment is strape's job, and strape has none), **marked** (zero XSS protection;
safe only because of two strape-side invariants).

---

## 4. Refuted — and one instructive false refutation

Seven findings were refuted. Five are genuine refutations of the useful kind: they establish that
per-directory trust with ancestor inheritance, the absence of extension sandboxing, `STRAPE_CODING_AGENT_DIR`
relocation, and `!`-prefixed shell commands in `auth.json` are all upstream's **documented design** reachable
only with write access already inside the trust boundary — correctly downgraded to `info` rather than inflated.
The orchestrator separately refuted an agent's "most severe" candidate: `!`-command injection via project
`models.json` is impossible because **there is no project-scoped `models.json`** (every load path uses
`agentDir`).

**Two refutations were artefacts of the review's own process, and this is the most important methodology
lesson here.** Both refuted STRAPE-2026-001 — the finding I had *reproduced end-to-end* — with reasoning of
the form "the code the claim describes does not exist in this tree", each explicitly citing commit
`5078975e7`, hunk 7, and the CI regression test. They were right about the tree and wrong about the
vulnerability: **I fixed the bug while the review was still running**, so the verifiers examined post-fix code.

Read correctly this is a strong result — two independent agents, not told a fix existed, traced the new code
and confirmed it closes the hole for never-trusted repos while preserving the feature for trusted ones. But as
a *verdict* it is wrong, and a less careful reader would conclude the finding was invalid.

**Rule adopted:** freeze the tree for the duration of a review pass, or re-run verification after any fix.
A review is a measurement of a specific commit; changing the subject mid-measurement corrupts the record.

---

## 5. Where this review fell short — and what was since fixed

Stated plainly, because a review that hides its gaps is worse than no review. Three limitations were reported
on 2026-08-06; all three were addressed on 2026-08-07 and the resolutions are recorded here rather than
quietly replacing the original text.

### Resolved: the rate-limit truncation

16 of Job A's 66 agents failed (15 on the session limit, 1 on a connection error), which cost the `tool-fs`
hot-path review, 14 adversarial verifications, and the synthesis agent.

- **`tool-fs` was re-run** on resume and produced 8 findings (1 high, 3 medium, 2 low, 2 info) — including a
  high: `write`/`edit` can rewrite the harness's own trust store, user settings and user skills.
- **The verification backlog was cleared.** Deduplicated across both runs the review has **92 unique
  findings**, not 45 — the earlier number counted one journal only. Of those, 47 had verdicts; a dedicated
  pass on 2026-08-07 dispatched the 16 unverified high/medium findings and returned 15 verdicts (12 CONFIRMED,
  1 FIXED_IN_STRAPE, 1 PLAUSIBLE, 1 REFUTED; one agent exhausted its structured-output retries). **63 of 92
  are now verified and no high or medium finding is unverified.** 29 low/info remain — recorded as unverified,
  not as refuted.
- **The synthesis was written by hand** from the journal instead (`strape/audit/review-v0.84.0.md`).

That pass also *raised* a severity: `agent-dir-umask-perms` went medium → high, because at umask 002
`~/.strape/agent` is **group-writable** and user-scope extensions load from it with no trust gate.

### Resolved: the tree-freeze / false-refutation problem

Two verifiers had "refuted" `STRAPE-2026-001` by examining post-fix code, citing our own commit. The fix is
structural, not a note-to-self: verifiers now get a fourth verdict, **`FIXED_IN_STRAPE`**, and are told to read
`strape/docs/HUNKS.md` first. `REFUTED` means "never real"; `FIXED_IN_STRAPE` means "real, and we closed it" —
conflating them loses the reason a hunk exists, and the next person deletes the hunk. The backlog pass used
this and correctly returned `FIXED_IN_STRAPE` for the symlink finding. The rule, and the requirement to report
verdict *coverage* as a number, are now written into `.claude/skills/source-audit`.

### Resolved, and it found a real problem: the test suite

`./test.sh` **can** run here — it isolates `HOME`, and Volta's shim resolves its toolchain from `$HOME`, so
putting the real node binary first in `PATH` avoids the shim. And it does **not** exit 0; that earlier reading
came from a pipe to `tail -20`, so the status belonged to `tail`.

Measured properly: `pi-coding-agent` fails **16 test files / 71 tests** (194 passed); every other workspace
passes. Attribution by isolation — a worktree with only hunks 7-9 reverted fails 41 of the same tests, with
them 50 — gives exactly **9 failures caused by strape's security fixes, all by hunk 9** (tests asserting the
literal npm install argv, which now carries `--ignore-scripts`). **Hunks 7 and 8 break nothing.** The rest are
the rebrand: the tests hardcode `.pi` while the harness reads `.strape`.

A green suite would require editing the upstream test files upstream churns most, or reverting the fork's
purpose. The control adopted instead is `strape/audit/expected-test-failures.json` plus
`strape/scripts/test-expectations.mjs`: the exact 71-test set is pinned with a cause per entry, and CI fails on
**any** deviation — a new failure is a regression, and an expected failure that starts passing means upstream
changed the test. Both directions were verified by tampering with a captured log, and the gate refuses
truncated logs rather than silently passing. Details in `hand-verified-findings.md` HV-9.

### Still open

- **29 low/info findings carry no independent verification.** They are recorded as unverified.
- **~62 of the 71 test failures were not individually root-caused.** The spot-checked cause is the rebrand;
  that is an inference for the remainder, not a measurement.
- **289 trust-class capability sites were invisible to the sweep** when the capability-map agents ran
  (`\btrust` cannot match camelCase). Fixed afterwards — sites 235 → 524, total 1339 → 1628 — and the baseline
  regenerated, but those sites were never in the agents' material. See HV-8.
- **The review reviewed the wrong artifact once** (`retry@0.13.1` from the dev tree instead of the shipped
  `proper-lockfile/node_modules/retry@0.12.0`). Root cause was strape's own tooling; now guarded by
  `artifact-mismatch` and `path-moved` gate failures. See HV-7.
- **Tier C packages were not read**: `openai` (~440 largely generated files, grep-covered only, no
  tarball-vs-tag diff), `photon-node` (1.88MB unreadable WASM), `@mariozechner/clipboard` plus 10 native
  sidecars of which only `linux-x64-gnu` materialised. Basis is integrity pinning plus provenance, and the
  register says so.
- **Large files were sampled, not read whole** — `interactive-mode.ts` alone is thousands of lines.
- **Agent review is not proof.** HV-7, HV-8 and HV-9 are three cases where it looked at the wrong thing, and
  only the deterministic layer caught it.

## 6. Status

Infrastructure: **complete and tested in both directions** — every gate was verified to fail, not just to
pass. Review: **agent evidence gathered, human sign-off not done.** All 50 dependency entries and all four
high-scrutiny entries carry `reviewedBy: null` / `reviewedAt: null`, and the build gate fails on 26
escalations. That is the correct state.

One honest gap in the gate worth fixing: it validates entry presence, integrity match, `verdict === "allow"`
and install-script approval — but it does **not** read `reviewedBy`/`reviewedAt`. A human who flipped all 26
escalations to `allow` would pass the gate with the signature fields still null. The human-signature
requirement is currently a convention, not an enforced control.

Neither STRAPE-2026-001 nor STRAPE-2026-002 has been reported upstream yet. Both write-ups are
disclosure-ready in `strape/audit/`, including the honest counter-argument about whether upstream will consider
each in scope given their stated local-trust-boundary posture. STRAPE-2026-002 is the harder one for them to
decline: it needs no local write access, the victim performs no privileged action, and private files leave the
machine to a third party.
