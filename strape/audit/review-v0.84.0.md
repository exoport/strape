# Source security review — strape @ upstream pin v0.84.0

> **Why this is public.** Upstream pi's security policy puts this whole class of issue out of scope: it
> excludes "risks from working in untrusted repositories" and reports that require creating symlinks or
> workspace files on the target machine. So the weaknesses described here are, by upstream's own published
> position, working as intended rather than undisclosed vulnerabilities — there is nothing to coordinate.
> The analysis is also derived entirely from public source, and the issues strape has fixed are visible in the
> source diff and its regression tests either way. What differs is our threat model, not our assessment of
> upstream: strape runs against repositories cloned from the internet, so content arriving in a checkout is
> untrusted input here even where upstream reasonably treats it as user-controlled local state.

**Status: agent evidence gathered, human sign-off NOT done.** Nothing here is a clearance to build.

| | |
|---|---|
| Upstream pin | `v0.84.0` (`a5f43bf8aff3c55752432655f7334e3dafd1e256`) |
| Reviewed | 2026-08-06 / 2026-08-07 |
| Method | `.claude/skills/source-audit` — deterministic sweep → 12 capability-map agents (Sonnet) → 8 hot-path threat reviews (Opus, effort high) → per-finding adversarial verification (Sonnet) → this record |
| Raw findings | **92 unique**, deduplicated across both workflow runs (the earlier figure of 45 counted only the first run's journal) |
| Verified | **63** — 47 in the original passes, plus 16 dispatched in the 2026-08-07 backlog pass (§8), which returned 15 verdicts: 12 CONFIRMED (4 high, 8 medium), 1 FIXED_IN_STRAPE, 1 PLAUSIBLE, 1 REFUTED |
| Still unverified | **29**, all `low`/`info`. One medium (`catalog-baseurl-retarget`) carries an inherited verdict from its duplicate rather than its own — see §8 |
| Refuted | 8 (§5 — seven in the first passes, one added by the backlog pass) |
| Fixed in code | 6 (hunks 7, 8, 9, 10, 11, 12) — hunk 10 from §9, hunks 11 and 12 from §10 |

> This record was assembled by the orchestrator from the workflow journal because the synthesis agent that was
> to write it was killed by a session rate limit. The 12 capability-map sections in
> `capability-map/` are the agents' own output and are unaffected.

---

## 1. Scope

**In scope and reviewed:**

| Area | Size |
|---|---|
| `packages/coding-agent/src` | ~199 files / ~56k LOC |
| `packages/ai/src` — OpenAI/xAI paths only (`api/openai-*`, `providers/{openai,xai}`, `auth/oauth/{openai-codex,xai}`, shared event-stream / retry / error-body / dispatcher) | subset of 172 files |
| `packages/agent/src` | 48 files / ~12k LOC |
| `packages/tui/src` | 38 files / ~16k LOC (skim: capability sites only) |
| Deterministic sweep | 454 files, **1628** capability sites, 55 network hosts (the current baseline is 1651 — the delta is hunks 10-12's own code, itemised in §10) |

**Out of scope, declared:** `packages/{server,client,protocol,evals}` and `session-backends/sqlite-node`.
Justification: the `server` subcommand's `runServer()` has no implementation, `RemoteSession` is never
instantiated by the CLI, and `pi-server`/sqlite-node are absent from the 56-package shipped closure.
`pi-client`/`pi-protocol` do ship but are typebox-only CBOR plumbing reachable from no CLI path.

Dependencies are reviewed separately: `dep-review-v0.84.0.md`.

## 2. Threat model

T1 malicious repository content (files, `CLAUDE.md`/`AGENTS.md`, skills, `.strape/settings.json`) · T2
malicious model output · T3 local unprivileged attacker · T4 secret exfiltration · T5 runtime supply chain.
Severity is judged for a developer running strape on their own workstation with live provider keys and **no
sandbox**, with prompt injection assumed possible. Upstream's documented accepted risks are `info` unless
there is a bypass requiring no user approval.

Agents were seeded with upstream's own four CVEs (all fixed by 0.79.0) and asked to hunt variants:
CVE-2026-54325 extension loading without approval · CVE-2026-54328 predictable temp install paths →
privesc · CVE-2026-54326 HTML-export XSS · CVE-2026-54327 `auth.json` write race.

## 3. Findings fixed in code

Each reproduced before the fix, verified after, and pinned by a CI test.

| ID | Severity | Summary | Fix |
|---|---|---|---|
| context-file symlink read (hunk 8) | high | `statSync` follows symlinks, so a project `CLAUDE.md -> ~/.ssh/id_rsa` is read and sent to the model provider. Context files load with no trust prompt. **Inside strape's headline feature.** | hunk 8 — `lstatSync`, symlinks allowed only in the agent dir |
| (runtime installs) | medium | `grep -c "ignore-scripts"` over `core/package-manager.ts` = **0**: runtime extension/skill installs executed dependency lifecycle scripts, for packages never in the reviewed closure | hunk 9 — flag added to all four install builders |
| pre-trust settings merge (hunk 7) | medium-high | Startup `SettingsManager` merges untrusted project settings before trust is resolved, so a never-trusted repo chooses `sessionDir` and thus where the transcript lands | hunk 7 — use the persisted trust decision |
| self-update installs a server-named package (hunk 10) | medium-high | `strape update` (where `self` is the default target) fetches `pi.dev/api/latest-version` and installs `${latestRelease.packageName ?? PACKAGE_NAME}@${version}` **globally** — `packageName` comes from the response body (`utils/version-check.ts:78-80`) and the install branch fires *because* it differs. The only path that bypasses the shrinkwrap, integrity pinning, the SBOM, `reviewed-deps` and hunk 9's `--ignore-scripts` at once. Upstream ships this deliberately as a scope-rename migration (`test/package-command-paths.test.ts:625` asserts it), which is defensible when publisher and update server are the same party; strape is not that party | hunk 10 — refuse self-update on a non-official distribution, **before** the network call |
| trust escalation on `/reload` (hunk 11) | high | Two findings, one defect. A repo with no `.strape/` at startup is implicitly trusted (nothing to prompt about); `reload()` re-resolves trust only when the caller passes `resolveProjectTrust` and no caller does, so resources appearing mid-session are loaded and executed under the stale decision, which `maybeSaveImplicitProjectTrustAfterReload()` then writes to disk as permanent. Fixed 2026-08-08 — see §10 | hunk 11 — the loader fails closed when a project gains trust-requiring resources after being trusted implicitly; `--approve` and a persisted decision still honoured |
| agent dir created with the ambient umask (hunk 12) | high | `~/.strape` and `~/.strape/agent` created with no `mode` by four writers — 0755 at umask 022, **0775 at umask 002**. User extensions load from there with no trust gate (`package-manager.ts:2457-2463`), so on a umask-002 host any local account in the group can plant code strape runs at next start. Fixed 2026-08-08 — see §10 | hunk 12 — `ensureAgentDirPermissions()` creates 0700 and repairs a pre-existing dir, called from `main()` before the first read |

Also fixed, outside the npm boundary entirely: `rg`/`fd` were downloaded from GitHub's *latest release* and
executed with no checksum, signature, or pinned version (`utils/tools-manager.ts:108-123`, `:265-271`;
spawned at `core/tools/grep.ts:221`, `core/tools/find.ts:264`). Not npm packages, therefore invisible to the
lockfile, shrinkwrap hashes, SBOM, `npm audit`, `osv-scanner` and the reviewed-deps gate. Answered by
`strape/scripts/provision-tools.mjs` + `PI_OFFLINE=1`. See `hand-verified-findings.md` HV-1.

## 4. Confirmed, not fixed — accepted-risk register

Ordered by severity. Each is a deliberate acceptance, not an oversight.

| Sev | Finding | Where |
|---|---|---|
| high | HTML export interpolates the `read` tool's `offset`/`limit` arguments with no escaping and no type check, so a prompt-injected model tool call plants executable script in every later export of that session (CVE-2026-54326 class, model-controlled variant). Confirmed by repro, §8 | `core/export-html/template.js:953-955` |
| medium | jiti writes transpiled extension code to world-shared `/tmp/jiti` with predictable names; a poisoned cache entry is executed (CVE-2026-54328 sibling) | `core/extensions/loader.ts:444` |
| medium | `npmCommand` is merged from project settings, so a trusted repo chooses the argv strape spawns — including on paths not gated by `PI_OFFLINE` | `core/package-manager.ts:1721` |
| medium | `/share` writes the full transcript to a fixed, predictable `$TMPDIR/session.html` with default (world-readable) mode and no `O_EXCL`, so it is readable, symlink-clobberable and tamperable, and is left behind if the process dies before cleanup | `interactive-mode.ts:5838-5878`, `core/export-html/index.ts:280,314` |
| medium | HTML export interpolates `tokensBefore`/`exitCode` raw; session files are parsed without validation (CVE-2026-54326 class) | `core/export-html/template.js:1281,1297`, `core/session-manager.ts:299-314` |
| medium | HTML export splices theme `export.pageBg/cardBg/infoBg` unvalidated into the `<style>` block, so a trusted-project theme file can break out with `</style><script>`. The `colors.*` fields are **not** a vector (`hexToRgb` rejects them); only the `export` block is | `core/export-html/index.ts:111-128,151-167`, `template.html:7-9` |
| medium | Skill discovery follows directory symlinks with no visited-realpath set and no depth cap, so a small symlink fan-out in any scanned skills dir hangs startup before any prompt. `strape/scripts/claude-compat.mjs` adds `~/.claude/skills` at **user** scope, which is not trust-gated | `core/skills.ts:190-268`, `core/resource-loader.ts:684-703` |
| medium | Full bash output spills to world-readable `/tmp` files that are never deleted | `core/tools/output-accumulator.ts:216` |
| medium | Model-supplied bash command rendered to the terminal with no ANSI/control sanitisation (OSC 52 clipboard write, display spoofing) | `core/tools/bash.ts:230` |
| medium | Context-file discovery walks cwd→`/` with no trust gate and no repo boundary: a world-writable ancestor can inject a *regular* context file (hunk 8 closed only the symlink variant) | `core/resource-loader.ts:148` |
| medium | **`allowed-tools` skill frontmatter is documented but never parsed** — imported `~/.claude/skills` carry no capability limit | `core/skills.ts` |
| medium | Remote/persisted catalog entries can retarget a provider `baseUrl`, sending the key and conversation to another host. `parseCatalog()` normalises only `provider`; `mergeModels()` replaces a built-in model wholesale, and `model.baseUrl` reaches the SDK client unchanged. `PI_OFFLINE=1` blocks the automatic overlay, **but `strape update models` passes `allowNetwork:true` unconditionally** (`package-manager-cli.ts:397-415`) — an ordinary command, not a misconfiguration | `core/remote-catalog-provider.ts:9-31`, `packages/ai/src/models.ts:636-665`, `api/openai-responses.ts:250` |
| low | A repo-checked-in `.npmrc` steers the automatic startup `npm view` (cwd = project dir): registry redirect + env-var expansion into the URL. Downgraded from medium and marked PLAUSIBLE, not CONFIRMED: the launcher's default `PI_OFFLINE=1` gates the only automatic call site, so reaching it requires bypassing the documented launcher **and** a non-pinned `npm:` package **and** a live secret exported in the shell | `core/package-manager.ts:1484-1490`, `interactive-mode.ts:1013,1085-1101` |
| low | Session transcripts written with umask-default mode (0664 observed) while `auth.json` is hardened to 0600. This was previously called "safe because the parent dir is 0700" — the 2026-08-07 repro showed the parent dir was **not** 0700. Hunk 12 (§10) makes the parent 0700, so that mitigation is now real, but only while `sessionDir` stays under `~/.strape`; the file mode itself is still the ambient umask | `core/session-manager.ts:1030` |
| low | `auth.json` written by truncate-in-place rather than temp+rename; two writers touch it outside the hardened path (CVE-2026-54327 residue) | `core/auth-storage.ts:61` |
| low | SDK entry points (`sdk.ts:178`, `extensions/loader.ts:710`) load and execute `<cwd>/.strape/extensions/**` — embedders must not point them at untrusted dirs | `core/sdk.ts:178` |
| low | Git `ref` from a package source reaches `git fetch`/`git checkout` argv unvalidated | `utils/git.ts:99` |
| low | No https requirement on provider `baseUrl`: an `http://` value sends the key in clear text | `packages/ai/src/api/openai-codex-responses.ts:646` |
| low | Tool-call argument streaming re-parses the whole accumulated buffer per delta — quadratic on hostile input | `packages/ai/src/api/openai-completions.ts:534` |
| low | `--api-key` puts a secret in the process command line, readable by any local user | `cli/args.ts:93` |
| low | `<agentDir>/bin` is prepended to the PATH of every spawned command | `utils/shell.ts:122` |
| low | Skill name/description limits are warnings only — one `SKILL.md` can push an arbitrarily large blob into the prompt | `core/skills.ts:305` |
| low | Project-scope skills shadow user/Claude skills of the same name | `core/package-manager.ts:178` |
| info | `PI_OFFLINE` fails closed for automatic installs/update checks but is **ignored by explicit** install commands | `core/package-manager.ts:43` |
| info | Temporary extension install paths are fully deterministic (truncated sha256, no randomness) | `core/package-manager.ts:2089` |
| info | `strape auth print-api-key` / `print-bearer-token` print live credentials to stdout (and refresh+persist as a side effect) — a one-line exfiltration primitive if `bash` is ever auto-approved for the strape binary | `cli/credential-print.ts:122` |
| info | Every spawned command receives `PI_SESSION_FILE`/`PI_SESSION_ID`, handing shell commands a pointer to the transcript | `core/tools/bash.ts:171` |
| info | Model-supplied commands run via `bash -c` with the full environment and no approval gate in the tool itself | `core/tools/bash.ts:97` |
| info | `HTTP(S)_PROXY` silently routes all provider traffic | `core/http-dispatcher.ts:81` |
| info | Provider error bodies and model text reach the terminal and session log without control-character sanitisation | `packages/ai/src/utils/error-body.ts:16` |
| info | No sandbox; prompt injection unmitigated | by design |

**Operational consequences to adopt now (no code change):** keep `defaultProjectTrust: "ask"`; keep
`PI_OFFLINE=1` (launcher default); do not use `/share`; do not relocate `sessionDir` to a shared path; do not
run strape with a cwd under a world-writable ancestor; reuse only skills you wrote; never pass `--api-key`;
prefer `strape update models` only on a host where you accept a live call to `pi.dev`.

### Recommended next fixes (not yet applied)

The 2026-08-07 verification pass returned "fix now" for nine of the twelve CONFIRMED findings, plus one
defence-in-depth "fix now" on the PLAUSIBLE one. That is nine rows below: the two reload findings are one
change, and the `npm view` item is the PLAUSIBLE one, kept last because `PI_OFFLINE=1` already blocks its only
automatic call site. Each is a new hunk and must go through `strape/docs/HUNKS.md`'s process (justification,
overlay verification, regression test) before it lands. Listed in the order a maintainer should take them.

**Rows 1 and 2 are done** — they became hunks 11 and 12 on 2026-08-08 (§10). They are kept here, struck
through, so the ordering above and the "nine of twelve" arithmetic still read correctly against the pass that
produced them. Rows 3-9 remain unimplemented; no file under `packages/` was touched for them.

| # | Change | Where |
|---|---|---|
| 1 | ~~Re-evaluate `hasTrustRequiringProjectResources(cwd)` on **every** `reload()`, not only when the caller passes `resolveProjectTrust`, and re-prompt when project resources newly appear under a cwd that was only auto-trusted (never an explicit persisted decision). Separately, require explicit confirmation before `maybeSaveImplicitProjectTrustAfterReload()` writes `trusted:true` to the store~~ — **done, hunk 11.** Implemented as fail-closed rather than re-prompt (the loader has no UI), which also closes the second half for free: the session is no longer trusted, so the persist path stops firing | `core/resource-loader.ts:405-421`, `modes/interactive/interactive-mode.ts:4652-4671` |
| 2 | ~~Pass `mode: 0o700` on every `mkdirSync(..., { recursive: true })` that can create `~/.strape` or `~/.strape/agent`, **and** `chmod` to 0700 when the dir already exists with looser bits~~ — **done, hunk 12.** Implemented as one hardening call in `main()` ahead of the first read, rather than editing four writers: the recursive `mkdirSync` calls then only create leaves inside an already-0700 tree | `core/session-manager.ts:483-489`, `core/trust-manager.ts:132,138` |
| 3 | Type-check and `escapeHtml()` the `read` tool's `offset`/`limit` before interpolation, exactly as `file_path` is handled | `core/export-html/template.js:953-955` |
| 4 | Escape or `Number()`-validate `tokensBefore` and `exitCode`, and add schema validation in `parseSessionEntries()` so a crafted `.jsonl` cannot inject unexpected types | `core/export-html/template.js:1281,1297`, `core/session-manager.ts:299-314` |
| 5 | Validate every resolved theme colour against `^#[0-9a-fA-F]{6}$` (or reuse `hexToRgb`) before splicing into CSS, covering the `export.*` block that `createTheme` never touches | `modes/interactive/theme/theme.ts` (`getThemeExportColors`), `core/export-html/index.ts:111-128` |
| 6 | `/share`: `mkdtempSync` for an unpredictable path, `'wx'` flag so it refuses a pre-existing symlink, explicit `mode: 0o600`, and `try/finally` so the unlink runs even if `gh` throws | `interactive-mode.ts:5838-5878` |
| 7 | Strip `baseUrl` (and any other transport- or auth-affecting field) from remote catalog entries in `parseCatalog()` — let the catalog override display/pricing/capability metadata only, the way `provider` is already force-set rather than trusted. Also make `refreshModelCatalogs()` honour `PI_OFFLINE` | `core/remote-catalog-provider.ts:19-31`, `package-manager-cli.ts:397-415` |
| 8 | Thread a visited-realpath `Set` (and/or a depth cap) through skill directory recursion so a symlink fan-out is bounded regardless of the OS `ELOOP` threshold | `core/skills.ts:190-268`, `core/package-manager.ts` (`collectSkillEntries`) |
| 9 | Defence in depth for the `npm view` update check: run it with a neutral `cwd` (e.g. `os.tmpdir()`) and an explicit `--userconfig` / pinned `--registry`, so a repo `.npmrc` cannot influence it whatever the `PI_OFFLINE` state | `core/package-manager.ts:1484-1490` |

Not recommended for a fix: `allowed-tools` enforcement (already recorded in `HUNKS.md` as a deferred
tenth-hunk candidate — upstream ships it as documented-but-unimplemented, and the honest mitigation is to
reuse only skills you wrote) and XML-escaping context files (hygiene, not a boundary — see §5).

## 5. Refuted

Seven findings were refuted in the original passes; an eighth was refuted by the 2026-08-07 backlog pass
(`context-file-delimiter-breakout-forged-skills`, §8). Of the original seven, five are genuine and useful: per-directory trust with ancestor inheritance,
absence of extension sandboxing, `STRAPE_CODING_AGENT_DIR` relocation, `!`-shell values in `auth.json`, and
the `pi-ai` bin writing `./auth.json` are all upstream's **documented design**, reachable only with write
access already inside the trust boundary — correctly downgraded to `info` rather than inflated. The
orchestrator separately refuted an agent's "most severe" candidate: `!`-command injection via project
`models.json` is impossible because no project-scoped `models.json` exists (HV-6).

**Two refutations were process artefacts and must not be read as clearing anything.** Both refuted
the pre-trust settings finding (hunk 7) on the grounds that "the code the claim describes does not exist in this tree", each citing
commit `5078975e7`. They were right about the tree and wrong about the vulnerability: the fix landed **while
the review was still running**. Read correctly it is corroboration — two agents, not told a fix existed,
independently traced the new code and confirmed it closes the hole while preserving the trusted-project
feature. As a verdict it is wrong.

**Rule adopted:** freeze the tree for a review pass, or re-verify after any fix.

The eighth refutation is narrower and worth stating precisely. Context-file content *is* interpolated into
`<project_instructions>` with no XML escaping (`core/system-prompt.ts:58`, `:149`) while the skills list *is*
escaped (`core/skills.ts:352`) — the asymmetry is real and reproducible. It was refuted as a *vulnerability*
because no boundary is crossed: the harness introduces that same text with "Project-specific instructions and
guidelines:", i.e. it already tells the model to follow it, so an attacker who can write a context file can
get the same effect in plain English without forging any tags. It collapses into the accepted
"prompt injection unmitigated" row of §4. Escaping it anyway is cheap hygiene, not a fix.

## 6. Coverage limitations

- **A session rate limit killed 16 of 66 agents** (15 rate-limited, 1 connection error). The first pass of the
  `tool-fs` hot-path review — path containment for read/write/edit, a first-order area — was **lost** to that
  limit; the review itself **did run on resume** and produced 8 findings (1 high, 3 medium, 2 low, 2 info),
  which are included in the 92. What was lost is that first pass's output, not the coverage. The synthesis
  agent never ran, hence this hand-assembled record.
- **29 of 92 findings still carry no adversarial verification** and are marked `NO-VERDICT`. All 29 are
  `low` or `info`. The 16 `high`/`medium` findings that were unverified when this record was first written
  were dispatched on 2026-08-07 and are resolved in §8 — including the HIGH that became hunk 8,
  which the orchestrator had hand-verified in the interim and which the backlog pass independently returned
  as FIXED_IN_STRAPE.
- **289 trust-class capability sites were invisible to the sweep** when the capability-map agents ran: the
  `trust` patterns were `\b`-anchored and could not match camelCase (`isProjectTrusted`,
  `ProjectTrustStore`). Fixed after the fact (sites 235 → 524, total 1339 → 1628) and the baseline
  regenerated, but those sites were not in the agents' material. See HV-8.
- **Large files were sampled, not read whole** — `interactive-mode.ts` alone is thousands of lines; agents
  were pointed at its capability sites.
- **`packages/tui/src` was a skim** by design.
- **No clean test-suite run demonstrated.** `./test.sh` cannot run on the review host (it isolates `HOME`,
  breaking Volta). The load-bearing check — `packages/ai/test/lazy-module-load.test.ts`, proving the SDK trim
  is safe — passes 5/5 with zero module-resolution failures.
- **Agent review is not proof.** It finds what it looks for; HV-7 and HV-8 are two cases where it looked at
  the wrong thing and only the deterministic layer caught it.

## 7. Sign-off

Agent evidence and orchestrator hand-verification are complete for the scope above. A human must read this
record, `capability-map/`, `hand-verified-findings.md`, `../docs/SECURITY-BACKLOG.md`, and
`dep-review-v0.84.0.md`, then decide.

```
Upstream pin reviewed : v0.84.0 (a5f43bf8aff3c55752432655f7334e3dafd1e256)
Reviewer (name)       : ____________________________
Date                  : ____________________________
Accepted risks §4     : [ ] read and accepted
Open items §6         : [ ] read and accepted
Backlog verdicts §8   : [ ] read and accepted
Verdict               : [ ] approved for build   [ ] changes required
```

Until this block is filled and `reviewed-deps.json` verdicts are signed, the build gate fails — which is the
intended state.

## 8. Verification backlog cleared (2026-08-07)

The 16 `high`/`medium` findings that this record originally listed as `NO-VERDICT` were re-dispatched for
adversarial verification against the **current, post-hunk** tree — so a verdict here judges the code as
shipped, not the code the finder saw. 15 verdicts came back. Outcome: **12 CONFIRMED** (4 high, 8 medium),
**1 FIXED_IN_STRAPE**, **1 PLAUSIBLE**, **1 REFUTED**. No finding was upgraded out of `high`; one was raised
from medium to high (`agent-dir-umask-perms`) and one lowered from medium to low (`npm-view-cwd-npmrc-exfil`).
The 29 findings that remain unverified are all `low`/`info`.

| id | prev sev | verdict | corrected sev | recommendation |
|---|---|---|---|---|
| `trust-escalation-on-reload` | high | CONFIRMED | high | fix now — re-resolve trust on reload; confirm before persisting `trusted:true` |
| `implicit-trust-persisted-on-reload` | high | CONFIRMED | high | fix now — distinguish "explicitly trusted" from "auto-trusted because nothing was there yet" |
| `agent-dir-umask-perms` | high | CONFIRMED | **high** (unchanged claim, raised from the §4 medium row) | fix now — `mode: 0o700` on create **and** chmod a pre-existing dir |
| `export-read-offset-dom-xss` | high | CONFIRMED | high | fix now — type-check + `escapeHtml()` `offset`/`limit` |
| `context-file-symlink-exfil` † | high | **FIXED_IN_STRAPE** | info | none — closed by hunk 8 |
| `export-numeric-type-confusion-xss` | medium | CONFIRMED | medium | fix now — escape `tokensBefore`/`exitCode`; validate session entries |
| `export-theme-css-style-breakout` | medium | CONFIRMED | medium | fix now — strict hex validation before CSS injection (`export.*` block only) |
| `share-predictable-tmp-session-html` | medium | CONFIRMED | medium | fix now — `mkdtemp` + `'wx'` + `0600` + `try/finally` unlink |
| `remote-catalog-baseurl-override` | medium | CONFIRMED | medium | fix now — strip `baseUrl` in `parseCatalog()`; make `update models` honour `PI_OFFLINE` |
| `catalog-baseurl-retarget` | medium | (no verdict returned) | medium | same defect as the row above, same file — carries that verdict by inheritance, **not** independently re-verified |
| `skills-dir-symlink-loop-startup-hang` | medium | CONFIRMED | medium | fix now — visited-realpath set and/or depth cap |
| `context-file-ancestor-walk-ungated` † | medium | CONFIRMED | medium | (verifier returned no substantive recommendation; matches the existing §4 row) |
| `context-file-ancestor-walk-no-trust-no-repo-boundary` † | medium | CONFIRMED | medium | duplicate of the row above; same §4 row |
| `skill-allowed-tools-not-enforced` | medium | CONFIRMED | medium | accept and document — already a rejected tenth-hunk candidate in `HUNKS.md` |
| `npm-view-cwd-npmrc-exfil` | medium | PLAUSIBLE | **low** | fix now (defence in depth) — neutral `cwd` / `--userconfig`; real mitigation today is `PI_OFFLINE=1` |
| `context-file-delimiter-breakout-forged-skills` | medium | **REFUTED** | info | accept and document — subsumed by "prompt injection unmitigated" (§5) |

† These three verdicts arrived with placeholder reasoning and placeholder evidence fields rather than a traced
argument. They are recorded as returned, not as re-derived: `context-file-symlink-exfil` agrees with the
orchestrator's own hand-verification of hunk 8, and the two ancestor-walk entries agree with the §4 row that
already says hunk 8 closed only the symlink variant. Treat them as corroboration of an existing conclusion,
not as fresh evidence.

**What the four CONFIRMED highs mean for strape.** The two reload findings are the same defect seen from two
directions, and they are the most serious thing in this pass: a repo that has no `.strape/` when the session
starts is implicitly trusted (no prompt is shown, because there is nothing to prompt about), and that stale
`projectTrusted:true` is *preserved* across `/reload` because `resourceLoader.reload()` re-resolves trust only
when a caller passes `resolveProjectTrust` — and no caller does. So if `.strape/extensions/*` or
`.strape/SYSTEM.md` appears mid-session (a `git checkout`, a `stash pop`, a file the agent itself wrote), the
next `/reload` loads and executes it with no prompt, and `maybeSaveImplicitProjectTrustAfterReload()` then
writes `trusted:true` to disk permanently. Hunk 7 does **not** cover this: it hardened the *startup*
`SettingsManager` used for `sessionDir` resolution, and `trust-regression-test.mjs` pins only that behaviour.
This is CVE-2026-54325's class — extension loading without approval — reachable in the shipped build
(`dist/main.js:531,720` carry the same wiring). It was the one item in §4 that most deserved its own hunk, and
it became hunk 11 on 2026-08-08 (§10).

`agent-dir-umask-perms` was verified by direct repro and raised to high: `~/.strape` and `~/.strape/agent` are
created with no `mode`, so they inherit the ambient umask — 0755 at umask 022, and **0775 at umask 002**,
which is the default on Debian/Ubuntu-family systems with per-user groups. The 0775 case is the reason for the
upgrade: user extensions are loaded from `~/.strape/agent` unconditionally, with no trust gate
(`package-manager.ts:2457-2463`), so a group-writable agent dir lets any local account in that group plant
code that strape executes on next start. `auth.json`'s `mode: 0o700` on its parent is a no-op once the
directory already exists, so the codebase's own correct posture never gets applied. Closed by hunk 12 on
2026-08-08 (§10), whose repair half exists precisely because of that last sentence.

`export-read-offset-dom-xss` is the CVE-2026-54326 class with a worse trigger than the variant already in §4:
the injected value comes from the **model**, not from a hand-crafted session file. A prompt injection that
gets the model to emit a `read` call with a string `offset` is persisted verbatim into the transcript on
`message_end` — before and independently of the read tool's own argument validation — and is then interpolated
unescaped into any HTML export of that session. The exported page also embeds the whole transcript, so the
script runs in a document that contains whatever secrets were in the conversation. Anyone who exports or
`/share`s a session opens the payload in their browser.

**The one FIXED_IN_STRAPE.** `context-file-symlink-exfil` is closed by hunk 8 (`lstatSync`;
symlinks tolerated only inside the agent dir). It sits in §3 and was never in the accepted-risk register, so
nothing needed to move — the check in this pass was to confirm that no fixed issue is being carried as
accepted risk and no still-open issue was quietly promoted out of §4. Neither happened. The *ancestor-walk*
sibling remains open and stays in §4: hunk 8 refused the symlink, not the walk.

## 9. Identity-string sweep (2026-08-08)

A targeted sweep of user-facing string literals, prompted by the observation that hunks 3, 10 and 11 — the
whole rebrand class — had each been found by a person reading real CLI output, one per session, and never by a
gate. Scope: `modes/interactive/` and `cli/` first, then the rest of `packages/coding-agent/src/`.

**Method.** Deterministic (`rg` for `\bpi\b`, `\bPi\b`, `π`, `pi.dev`, `.pi`), then per-hit triage against
reachability: is the string user-facing, is the code path reachable in a fork build, and is the literal
deliberate. No LLM review pass; this is a mechanical sweep with human triage, and it is recorded separately
from §3 for that reason.

**Result.** 6 gaps in the two named directories and 5 more outside them, all merged into hunk 3. Two of the
eleven mattered beyond cosmetics:

- `core/system-prompt.ts:135-138` — four `pi` references *inside hunk 3's own block*, four lines below the two
  the hunk already fixed. The prompt introduced itself as "strape documentation" and then told the model to
  read "pi docs", "pi packages" and "pi .md files". Behavioural, and an incomplete fix is worse than a
  consistent name either way.
- `core/project-trust.ts:25` — the trust prompt itself interpolated `CONFIG_DIR_NAME` but hardcoded "pi".

**The sweep's actual find** was not a string: `getSelfUpdatePlan` installing a server-supplied package name
(§3, hunk 10). It surfaced because reading `package-manager-cli.ts` for its help text meant reading the
function underneath it.

**What this says about coverage.** §6 lists agent review's limits; this adds one for the deterministic layer.
The `piConfig` seam (`config.ts:487-496`) reaches ~13 files and produces a *convincing* rebrand, which is
exactly why the residue went unnoticed for three sessions — the failure mode of a good seam is that it looks
complete. `strape/scripts/rebrand-test.mjs` now asserts against real CLI output rather than source, because
that is the only check that would have caught any of these.

**Deliberately not changed**, with reasons, in `../docs/HUNKS.md` hunk 3 — notably
`core/session-manager.ts:905`, where rebranding one error message costs three upstream test assertions.

## 10. Backlog hardening pass — hunks 11 and 12 (2026-08-08)

The two `high` findings the 2026-08-07 pass ranked first (§8, "recommended next fixes" rows 1 and 2) were
implemented. Both were CONFIRMED by that pass and reproduced again here before the fix; neither is a new
finding, so this section records the *change*, not a new review. They move from §4 to §3.

**No review pass was running while these were written.** That is the §5 rule — a verifier reading post-fix
code reports the finding as never having been real — and it is why this pass was done after §8 and §9 closed
rather than alongside them.

| Hunk | Finding | Shape of the fix | Why not the obvious shape |
|---|---|---|---|
| 11 | `trust-escalation-on-reload` + `implicit-trust-persisted-on-reload` | The loader refuses to carry implicit trust across a reload once the project has gained trust-requiring resources | The pass recommended "re-prompt". The loader has no UI, and the reload callers that matter (`print-mode`, `rpc-mode`) have no user at all — so it fails closed and points at `/trust`. The second half of the finding needed no separate change: with the session untrusted, `maybeSaveImplicitProjectTrustAfterReload()` returns early on its own `isProjectTrusted()` check |
| 12 | `agent-dir-umask-perms` | `ensureAgentDirPermissions()` in `config.ts`, called once from `main()` before the bootstrap `SettingsManager` | The pass recommended `mode: 0o700` on each of the four writers. Hardening the directory *before* the first read gets the same result in two files instead of six, because those writers create their leaves inside an already-0700 tree. The repair (`chmod`) half is the part that actually matters for existing installs, and mode-on-create could never have supplied it |

**What was deliberately *not* fixed alongside them.** Hunk 12 closes the directory, not the files inside it.
Session transcripts (`core/session-manager.ts:1030`) and the `/share` export are still created with the
ambient umask; they are now protected by a 0700 parent, which is the mitigation §4's low row had previously
claimed without it being true. That row is updated, not removed — a `sessionDir` relocated outside
`~/.strape` still loses the protection, which is why the operational advice against relocating it stands.

**Scope of the stand-aside conditions in hunk 11.** `--approve`/`--no-approve` and a persisted `trusted: true`
both suppress the guard. That is a deliberate narrowing: the finding is about trust the user never granted,
and a guard that also revoked trust the user *did* grant would be a different, worse change — it would break
a documented flag and train people to work around the warning. Each condition has its own assertion in
`strape/scripts/trust-regression-test.mjs` so the narrowing cannot be widened by accident.

**Verification.** Both hunks were driven end to end against the built code, not just asserted in source:
`trust-regression-test.mjs` (10 assertions, 6 of them hunk 11) reproduces the escalation through the real
`DefaultResourceLoader`, and `agent-dir-perms-test.mjs` (11 assertions) covers the umask-002 case, the
custom-location negative test and the warn-don't-throw path. Both invariants were negative-tested against
`git show vendor:<file>` and fail there, per the `HUNKS.md` rule that an invariant which cannot fail is worse
than none. The expected-test-failure set is unchanged at 75 — neither hunk breaks an upstream test.

**Capability drift.** The sweep moved `fs-write` 105 → 107 and `trust` 524 → 545; every new site is in
`config.ts`, `core/resource-loader.ts` or `main.ts` and belongs to these two hunks. The regeneration also
absorbed four `+1/-1` pairs from §9's identity-string sweep whose baseline was never regenerated — equal
counts, so the count-based drift check could not see them. Worth knowing: `capability-sweep --check` compares
totals per class, so a same-size edit to a matched line is invisible to it.

### 10a. Manual verification in the sandbox, and what it changed (2026-08-08)

Both hunks were exercised live, not only through their regression tests. This subsection exists because the
manual pass changed hunk 11 — the tests were green against a hunk that did not actually work for a user.

**Hunk 12 — confirmed as designed.** On a umask-002 host, `strape-sandbox --init` creates
`~/.strape` and `~/.strape/agent` at **0775** (its `mkdir -p` runs on the host, with the host umask), and one
`strape --version` inside the sandbox leaves both at **0700**. That is the repair half — a pre-existing
group-writable directory — which mode-on-create could never have covered.

The same run showed the limit of the hunk, now recorded in Part 2 P2: inside the 0700 agent dir,
`settings.json` and `models.json` are `0664` and `bin/` is `0775` — and `bin/` holds the `rg`/`fd` binaries
the harness executes. Unreachable while traversal stops at the 0700 parent; live the moment
`STRAPE_CODING_AGENT_DIR` points somewhere with a looser parent.

**Hunk 11 — worked, and was invisible.** The guard fired and the persist path correctly did not (the status
line read `Reloaded …` rather than `Reloaded …; saved project trust`). But what the user saw was a fragment of
the warning beginning mid-word — `licy: a project that had nothing to trust…` — because `console.error` is a
raw write to a screen the TUI owns and was overdrawn. No banner appeared either, because
`rebuildChatFromMessages()` clears the chat container during reload. **A project that had just been revoked
looked trusted.**

Fixed by calling upstream's `renderProjectTrustWarningIfNeeded()` from the reload handler, and cutting the
loader's line to one short clause (print mode, rpc mode and the SDK still need it and have no TUI). Note the
banner gap is upstream's and predates this hunk: any untrusted project looked trusted after `/reload`.

**Two process notes, both cheap and both earned here:**

1. **The invariant for the fix was toothless on its first attempt.** It searched the whole file for
   `renderProjectTrustWarningIfNeeded();`, which upstream already calls once from `renderInitialMessages()` —
   so it passed against pristine vendor source. The negative test against `git show vendor:` caught it. It is
   now anchored between two strings that bracket the reload handler. This is the second time the
   negative-test rule has paid for itself, and the first time it caught an assertion rather than a revert.
2. **Green tests did not mean a working control.** Every hunk-11 assertion passed against a build whose
   warning was unreadable and whose banner never rendered, because they all asserted state
   (`isProjectTrusted()`, `getSessionDir()`) and none asserted that a human is told. For a control whose whole
   purpose is to make someone stop and decide, "is it visible?" is part of the specification.

**Manual verification completed 2026-08-08**, after the visibility fix, in the bubblewrap sandbox against the
built CLI. All three of hunk 11's states were driven by hand:

| Case | Setup | Observed |
|---|---|---|
| Guard fires | no `.strape/` at startup, `.strape/skills/probe` added mid-session | untrusted banner rendered in-frame, `probe` refused, status line **without** `; saved project trust` |
| Stand aside — persisted | `/trust` → `Trust`, restart | no prompt, no banner, `probe` loads; a further `/reload` keeps it and stays silent |
| Stand aside — `--approve` | `trust.json` and `.strape/` both cleared first, launched `--approve` | `probe` loads across `/reload`, no banner, and **nothing written to `trust.json`** |

The third row needed both preconditions cleared to mean anything: the trust store keys on the *in-sandbox*
path (`/mnt/workspace`), so a leftover entry from the second row would have made the guard stand aside for the
wrong reason while `--approve` was never consulted. Worth remembering when re-running this — binding a
different host directory does **not** give a fresh trust identity.

The final check confirms a one-run flag stays one-run: upstream sets `autoTrustOnReloadCwd` to `undefined`
whenever an override is present, so `--approve` cannot be silently promoted to a persisted decision.

Hunk 12 was confirmed a second time on the real sandbox agent dir (`0700` on both levels), which also put
numbers on the Part 2 P2 residue: `auth.json` and `models-store.json` are `0600`, but `settings.json` and
`trust.json` are `0664` and `sessions/` is `0775` — all protected by the parent alone.
