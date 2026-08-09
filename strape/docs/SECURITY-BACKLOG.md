# strape security backlog

What strape has hardened relative to upstream, and what still needs work. This is engineering documentation for
the fork: the "why" behind each hunk, and a prioritised list of what to fix next.

> **Why this is public.** Upstream pi's security policy puts this whole class of issue out of scope: it
> excludes "risks from working in untrusted repositories" and reports that require creating symlinks or
> workspace files on the target machine. So the weaknesses described here are, by upstream's own published
> position, working as intended rather than undisclosed vulnerabilities — there is nothing to coordinate.
> The analysis is also derived entirely from public source, and the issues strape has fixed are visible in the
> source diff and its regression tests either way. What differs is our threat model, not our assessment of
> upstream: strape runs against repositories cloned from the internet, so content arriving in a checkout is
> untrusted input here even where upstream reasonably treats it as user-controlled local state.

**strape's threat model differs from upstream's**, which is the reason this file exists: we run the harness on
developer workstations against repositories cloned from the internet, so several things upstream reasonably
declines to treat as bugs are things strape must either fix or consciously accept.

Evidence for everything below is in `strape/audit/`: `review-v0.84.0.md` (source review),
`dep-review-v0.84.0.md` (dependencies), `hand-verified-findings.md` (checked by hand), `capability-map/`
(what the program can do), plus the machine-readable baselines the CI gates check against.

---

## Part 1 — hardened already (keep these; each has a test)

Do not remove a hunk without reading why it exists. Each is pinned by a test so a merge cannot silently revert
it, and `strape/scripts/verify-overlay.mjs` asserts all of them.

### Hunk 7 — project settings are gated on persisted trust (`main.ts`)

**What was wrong.** The startup `SettingsManager` was created before project trust was resolved, and
`SettingsManager.fromStorage` defaults `projectTrusted` to `true` (`core/settings-manager.ts:325`). So a
never-trusted repository's `.strape/settings.json` was parsed and merged, and its `sessionDir` decided where
the session transcript was written (`main.ts` startup path) — before any prompt, and regardless of
`--no-approve`.

**Why it mattered here.** The transcript accumulates file contents the agent read, command output, and anything
pasted into the session. A repo-relative path meant the victim's own `git add -A && git commit && git push`
would publish their transcript. No exploit code runs at any point.

**The fix.** Pass the *persisted* decision (`new ProjectTrustStore(agentDir).get(cwd) === true`), which needs no
prompt at that point in startup. Chosen over a blunt `projectTrusted: false` because project-scoped `sessionDir`
is a documented feature and should keep working for projects the user actually trusted.

**Pinned by** four assertions in `strape/scripts/trust-regression-test.mjs`. One deliberately checks
whether upstream's default is *still* `true`, so if upstream changes it we are told to retire the hunk rather
than carry it forever.

### Hunk 8 — project context files must be regular files, not symlinks (`core/resource-loader.ts`)

**What was wrong.** The guard was `statSync(filePath).isFile()`, and `statSync` follows symlinks — so a project
`CLAUDE.md` symlinked to any readable file passed the check. Context files load with **no trust prompt** and
their contents go into the system prompt sent to the model provider, so a cloned repository containing one
symlink caused arbitrary local files to be read and transmitted off-box.

**Why it mattered here.** This sits inside strape's headline feature. Reusing `CLAUDE.md` without this fix would
have meant shipping the vulnerability as a selling point.

**The fix.** `lstatSync(...).isSymbolicLink()` → skip, with a warning. `allowSymlink: true` is passed **only**
for the agent-dir lookup, because `strape/scripts/claude-compat.mjs` deliberately links `~/.claude/CLAUDE.md`
there and that directory belongs to the user.

**Pinned by** two assertions in `strape/scripts/compat-test.mjs` — one that project symlinks stay refused, one
that the global symlink keeps working, so a future "fix" cannot silently break `claude-compat --global`.

### Hunk 9 — `--ignore-scripts` on runtime installs (`core/package-manager.ts`)

**What was wrong.** `grep -c "ignore-scripts"` over that file returned **0**. strape's whole build posture is
`--ignore-scripts` with an empty install-script allowlist, but extension and skill installs happen at *runtime*
through a different path, so a dependency's `postinstall` executed with the user's privileges — for a package
that was never in the reviewed closure at all. The dependency gate, the SBOM and the reviewed-deps allowlist all
describe the build; none of them described this.

**The fix.** The flag on all four install-arg builders (npm, pnpm, bun, git-dependency). An extension that
genuinely needs a lifecycle script now fails loudly, which is correct: that is a human decision.

**Pinned by** a `verify-overlay` invariant asserting each builder separately, so a merge cannot drop one.

### Hunk 10 — a vendor fork must never self-update (`package-manager-cli.ts`)

**What was wrong.** `strape update` (where `self` is the **default** target with no argument) called
`getSelfUpdatePlan`, which fetches `https://pi.dev/api/latest-version` and installs
`` `${latestRelease.packageName ?? PACKAGE_NAME}@${version}` `` globally. `packageName` comes from the response
body (`utils/version-check.ts:78-80`), and the install branch fires *specifically when it differs* from
`PACKAGE_NAME`. A response naming any package therefore installed that package with the user's privileges.

**This is upstream's intended behaviour, not an upstream oversight.** `test/package-command-paths.test.ts:625`
stubs `fetch` to return `{ packageName: "@new-scope/pi" }` and asserts the CLI runs `npm uninstall -g` on
itself followed by `npm install -g @new-scope/pi@…`. It is a scope-rename migration path — the project really
did move from `@mariozechner` to `@earendil-works` — and for a first-party distribution, where the update
server and the publisher are the same party, it is a defensible design.

**Why it mattered here.** strape's threat model differs: we are not that party. This is the one path that
bypasses every dependency control strape has at once — not
in the shrinkwrap, no integrity hash, no `reviewed-deps` verdict, and hunk 9's `--ignore-scripts` does not
reach it. Even the benign path replaces a build pinned to a reviewed tag with upstream's latest npm publish —
CLAUDE.md non-negotiable 3, violated at runtime by a one-word command.

**The fix.** Refuse before the network call when the distribution triple is not upstream's, so a fork never
contacts pi.dev at all. Mirrors upstream's own `isOfficialDistribution` (`cli/startup-ui.ts:26-42`) rather than
importing it — that module pulls in the TUI theme stack — and retires itself if strape is ever un-forked.

**Chosen over the launcher.** `PI_OFFLINE=1` does close the path (`utils/version-check.ts:55`), but only for
people who go through `strape/bin/strape`; running `dist/cli.js` directly reopens it. A control that a normal
invocation can skip is not a control.

**Pinned by** `strape/scripts/rebrand-test.mjs`, which asserts the refusal with `PI_OFFLINE` **unset** — the
assertion that distinguishes the code guard from the launcher — plus a `verify-overlay` invariant that checks
the guard still precedes `getLatestPiRelease` and that upstream's `OFFICIAL_*` constants have not moved.
Three upstream tests now fail by design; they are recorded in `strape/audit/expected-test-failures.json` under
`hunk: "10"`, which also means CI tells us if upstream ever changes this path.

**Related, and worth knowing: `PI_OFFLINE=0` is a split state, not "offline off".** Upstream parses the
variable two different ways, and `0` opens exactly the paths that matter most:

| `PI_OFFLINE=0` | Sites |
|---|---|
| **fails open** (`isTruthyEnvFlag`, so `"0"` is false) | `utils/tools-manager.ts:14` — unverified `rg`/`fd` download; `core/package-manager.ts:42` — runtime npm installs; `main.ts:531` — stops forcing `PI_SKIP_VERSION_CHECK` |
| **fails closed** (raw string truthiness / `=== undefined`) | `utils/version-check.ts:55`, `core/model-runtime.ts:194`, `modes/interactive/interactive-mode.ts:995,1086,1182` |

`strape/bin/strape` previously documented `PI_OFFLINE=0` as the single-run override. It now says to unset the
variable instead (`env -u PI_OFFLINE`), which is the only setting that behaves consistently. Left as an
upstream inconsistency rather than a hunk of its own: it is a documentation fix on our side, and normalising the
parse would mean touching six files.

### Hunk 11 — implicit project trust does not survive a reload (`core/resource-loader.ts`, `main.ts`, `interactive-mode.ts`)

**What was wrong.** A project with nothing trust-requiring in it is trusted with **no prompt**, because there
is nothing to trust (`core/project-trust.ts:50-52`). Upstream re-resolves that decision only when the caller
passes `resolveProjectTrust`, and no `/reload` caller does: `core/agent-session.ts:2618` calls
`this._resourceLoader.reload()` with no arguments, and so do `modes/print-mode.ts:98` and
`modes/rpc/rpc-mode.ts:342`.

So a repository that gains `.strape/settings.json`, `extensions/`, `skills/`, `prompts/`, `themes/`,
`SYSTEM.md` or `APPEND_SYSTEM.md` *during* a session had them loaded and **executed** at the next `/reload`
under the startup decision. `modes/interactive/interactive-mode.ts:4652` then wrote that inherited decision
to the trust store as a permanent `trusted: true`, with no prompt — so the escalation outlived the session.

**Why it mattered here.** The resources do not have to be planted by an attacker with a shell: a `git pull`
on a branch, a checkout switch, or the model itself writing a file is enough. Extensions in that directory
run code. This is the same class as the extension-loading issue upstream already treats as a vulnerability;
what upstream does not treat as in scope is the repository being the source.

**The fix.** Fail closed in the loader: if the project was trusted implicitly and has since gained
trust-requiring resources, reload it as untrusted and warn. `/trust` remains the deliberate path, and because
the session is no longer marked trusted, upstream's persist-on-reload path stops firing on its own.

It stands aside in three cases — `--approve`/`--no-approve` (the user stated a decision for the run, which
`main.ts` now forwards to the loader), a persisted `trusted: true` for that path, and the first load. Those
matter as much as the guard: without them this is a blunt revoke-on-reload that breaks the flag and punishes
projects the user really did trust.

**Chosen over a fix in `/reload`'s handler.** Living in the loader covers print mode, rpc mode and the SDK at
the same cost, and cannot be skipped by a caller that forgets it.

**A revocation the user cannot see is not a control**, and the first version of this hunk was one. Found by
running a real `/reload` rather than a test: the loader's `console.error` is a raw write to a screen the TUI
owns, so it was overdrawn mid-word and read as terminal corruption — and `rebuildChatFromMessages()` clears
the chat container during reload, discarding the startup trust banner. The net effect in the TUI was a
project that had just been revoked looking trusted. The reload handler now re-renders upstream's own
`renderProjectTrustWarningIfNeeded()`, which draws in-frame and names the remedy (`/trust`, then restart).

Worth separating: that second half is **upstream's gap, not this hunk's**. `rebuildChatFromMessages()` has
always dropped the banner on reload, so any untrusted project — however it became untrusted — looked trusted
after `/reload`. The one-line fix closes it for every case, not just ours.

**Pinned by** six assertions in `strape/scripts/trust-regression-test.mjs` — the escalation driven end to end
through the real loader, both stand-aside cases, a source pin, and a detector that reports when upstream
starts resolving trust in `reload()` so the hunk can be retired rather than carried forever.

### Hunk 12 — the agent directory is private (`config.ts`, `main.ts`)

**What was wrong.** `~/.strape` and `~/.strape/agent` are created by four writers with the ambient umask:
`core/trust-manager.ts` (trust.json and its lock directory), `core/settings-manager.ts`,
`core/session-manager.ts` (recursively, so it creates the parents too) and `migrations.ts`. That is 0755 at
umask 022 and **0775 — group-writable — at umask 002**, which is the default on Debian/Ubuntu and inside many
container images. `auth.json`'s mode is corrected after it is written, but nothing corrects a directory, and
nothing corrects anything that already exists.

**Why it mattered here.** User-scope extensions load from that directory with **no trust gate**. On a
umask-002 machine another local account can drop in an extension that runs on the next start — and the same
directory holds `auth.json`, `trust.json` and the session transcripts.

**The fix.** `ensureAgentDirPermissions()` in `config.ts`, called once from `main()` before the bootstrap
`SettingsManager`: create the directories 0700 when missing, `chmod` them to 0700 when they exist with any
group or other bits set. Both halves are needed — creation covers a fresh install, the `chmod` covers every
install that already exists. Placing the call before the first read means the four recursive `mkdirSync`
calls only ever create leaves *inside* an already-0700 tree, so they need no change and the hunk stays two
files instead of six.

Only the **default** location is hardened up to its parent. With `STRAPE_CODING_AGENT_DIR` pointing
elsewhere, the parent is a directory the user chose for their own reasons — `~/work/agent` would mean
chmodding `~/work`. Failures warn rather than throw: a read-only filesystem must not stop the agent starting.

**Pinned by** `strape/scripts/agent-dir-perms-test.mjs` (11 assertions, including the umask-002 case, the
custom-location negative test, and the warn-don't-throw path).

**Still open:** this closes the directory, not the files inside it. Session transcripts and the `/share`
export are still created with the umask default — see Part 2 P2, which is now only mitigated by the parent
directory being restrictive.

### Outside the npm boundary — pinned, verified `rg`/`fd`

`utils/tools-manager.ts` resolves versions from GitHub's *latest release* endpoint at runtime, downloads the
archives, and the binaries are spawned by the `grep`/`find` tools — with no checksum, signature, or pinned
version. Because rg and fd are **not npm packages**, the lockfile, shrinkwrap hashes, SBOM, `npm audit`,
`osv-scanner` and the reviewed-deps gate all report the project clean while a fresh install fetches and executes
unverified native code on first `grep`.

**Handled by** `strape/scripts/provision-tools.mjs` (pinned versions, recorded sha256, verify-before-install,
refuse-on-mismatch) installing into the directory the harness already searches, plus `PI_OFFLINE=1` in the
launcher keeping upstream's unverified path closed. It was verified that ripgrep's releases publish `.sha256`
files but **no** artifact attestation, so no signature-verification tool could have covered this either.

### Provider scope, and why Gemini cost nothing

Gemini rides Google's **OpenAI-compatible endpoint**, declared in `models.json` as an `openai-completions`
provider (`strape/scripts/claude-compat.mjs --global` writes it). That reuses the `openai` client already in the
shipped closure and adds **zero packages**. The native route — `@google/genai`, which pi's built-in `google`
provider uses — was measured and rejected: it takes the shipped closure from **56 to 93 packages** and puts
install-script packages back from **0 to 2** (`@google/genai` preinstall, `protobufjs` postinstall), which would
also force hunk 5's empty allowlist open. Reach for it only if you hit a Gemini feature the compatibility layer
does not expose (thinking-budget config, safety settings, context caching), and treat it as a
dependency-review event.

### Hunk 13 — cross-origin redirects are refused (`core/http-dispatcher.ts`)

**What was wrong.** undici's `fetch()` strips `Authorization`/`Cookie`/`Proxy-Authorization` across an origin
boundary but, per spec, keeps every other header and **replays the request body** on 307/308. strape's provider
calls use the global `fetch` that `undici.install()` replaces, so a DNS-hijacked or compromised provider host
answering 307 would receive the entire conversation. Found by the dependency review's adversarial pass on
undici, which established the path is live rather than theoretical.

**Why it mattered here.** The conversation is the asset. Bearer tokens happen to be stripped; `api-key` and
`x-api-key` style headers are not, and every prompt, file excerpt and command output in the session is in that
body.

**The fix.** An undici interceptor composed onto the global dispatcher, refusing any 301/302/303/307/308 whose
`Location` leaves the request origin. Not a hostname allowlist — that would encode today's provider set and
break every legitimate custom `baseURL`. Same-origin redirects still work; an unparseable `Location` fails
closed.

**Pinned by** `strape/scripts/redirect-guard-test.mjs` — six assertions against two real loopback HTTP servers.
The exfiltration assertion checks what the **attacker server received**, because a guard that errored after
replaying the body would still be a breach. Against pristine upstream the test reproduces the leak.

### Hunk 14 — jiti's transpile cache is out of `/tmp` (`core/extensions/loader.ts`)

**What was wrong.** `createJiti` was called with only `{ moduleCache: false }`, so `fsCache` kept its default:
on, at `os.tmpdir()/jiti`. Transpiled extension code was written there with the ambient umask (observed 775
dirs / 664 files under a world-writable `/tmp`) and later re-executed through `vm.runInThisContext` on a
content-hash marker match.

**Why it mattered here.** A local principal who can pre-create or write that directory plants code strape runs
with the developer's provider keys. It needs a hostile local user, which is why it is a one-line fix rather
than an emergency — but the fix costs nothing.

**The fix.** `fsCache: path.join(getAgentDir(), "cache", "jiti")`. It reuses hunk 12: that tree is created and
repaired as 0700 before anything reads or writes there, so the cache is protected by its parent exactly as
`sessions/` and `bin/` are.

**Pinned by** `strape/scripts/jiti-cache-test.mjs`, which loads a real `.ts` extension through
`loadExtensions()` and then inspects the filesystem rather than asserting on the option literal. A fourth
assertion pins the other jiti call-site guarantee: `transformOptions` must appear in no source file, since
`dist/babel.cjs` spreads a caller-supplied `...r.babel` after its safe defaults.

---

## Part 2 — needs fixing (prioritised)

Ordered by what a developer running strape against cloned repositories is actually exposed to. Each entry names
the change, not just the problem. None are applied.

The former P1 (trust escalation on `/reload`) and P2 (agent directory created with the ambient umask) are now
hunks 11 and 12 in Part 1. The rest have moved up; the numbers are a running priority order, not stable slots
like hunk numbers.

### P1 — HTML export escaping

`core/export-html/template.js`, `core/export-html/index.ts`

Three separate injection paths into exported session HTML: the `read` tool's `offset`/`limit` arguments are
interpolated unescaped (so a prompt-injected model tool call plants script in every later export of that
session); `compaction.tokensBefore` and `bashExecution.exitCode` are interpolated raw with no type check; and
theme `export.pageBg/cardBg/infoBg` strings are spliced into the `<style>` block unvalidated, allowing a
`</style><script>` breakout. (The `colors.*` fields are *not* a vector — `hexToRgb` rejects them.)

**Change:** type-check the numeric fields, `escapeHtml()` the tool-argument fields, and validate theme colour
strings against a strict pattern before they reach the template.

### P2 — world-readable transcript and output files

`core/tools/output-accumulator.ts`, `modes/interactive/interactive-mode.ts`, `core/session-manager.ts`

Bash output over the truncation threshold spills to files in the shared temp directory that are never deleted.
`/share` writes the full transcript to a fixed, predictable `$TMPDIR/session.html` with default mode and no
`O_EXCL` — readable, symlink-clobberable, and left behind if the process dies. Session transcripts are created
with the umask default (0664 observed), safe **only** because the parent directory is restrictive — which is
now true by construction (hunk 12) rather than by luck, but stops being true the moment `sessionDir` is
relocated outside `~/.strape`.

Everything else inside the agent dir has the same shape, measured on a umask-002 host after hunk 12:
`~/.strape/agent` is `0700`, but `models.json` and `settings.json` are `0664` and **`bin/` is `0775`** — and
`bin/` is where `provision-tools.mjs` puts the `rg`/`fd` binaries the harness *executes*. Group-writable
executables are unreachable today because traversal stops at the 0700 parent; they become live the moment
someone points `STRAPE_CODING_AGENT_DIR` somewhere with a looser parent, which is exactly the case hunk 12
deliberately does not harden up to the parent.

**Change:** create all three with mode 0600, use `O_EXCL` with an unpredictable suffix for the share/export
temp file, and unlink the bash overflow file once the result is consumed. Extend the same pass to `bin/`
(0700) and the agent-dir JSON files (0600), so the tree does not depend on one directory for all of its
confidentiality. Operational mitigation until then: do not use `/share`, do not relocate `sessionDir` to a
shared path, and if you set `STRAPE_CODING_AGENT_DIR`, put it somewhere only you can traverse.

### P3 — context-file discovery has no repository boundary

`core/resource-loader.ts`

Discovery walks from cwd to the filesystem root with no trust gate and no repo boundary, so a world-writable
ancestor — working under `/tmp`, or a shared parent directory — can inject a *regular* context file into the
system prompt. Hunk 8 closed only the symlink variant of this.

**Change:** stop the walk at the repository root (or at a filesystem boundary), and skip any directory that is
group- or world-writable. Operational mitigation until then: do not run strape with a cwd under a path other
users can write.

### P4 — `allowed-tools` in skill frontmatter is not enforced

`core/skills.ts`

Documented as experimental but never parsed. Directly relevant to strape's `.claude/skills` reuse: imported
skills carry no capability limit at all, so the only real control is provenance of the skill itself.

**Change:** either implement enforcement, or make the loader warn loudly when a skill declares `allowed-tools`
so nobody builds a security assumption on it. Until then, the rule stands: reuse skills you wrote, not skills
you found.

### P5 — smaller items worth batching

- **`npm view` runs inside the untrusted repo**, so a repo-supplied `.npmrc` can redirect the registry and
  expand environment variables into an `Authorization` header. `PI_OFFLINE=1` closes the common path; the fix
  is to run npm metadata queries with a controlled cwd and a pinned `--userconfig`.
- **`npmCommand` is merged from project settings**, so a trusted repo chooses the argv strape spawns. Treat
  settings-derived argv as untrusted input.
- **Skill discovery follows directory symlinks** with no visited-realpath set and no depth cap, so a small
  symlink fan-out in a scanned skills directory hangs startup before any prompt. `claude-compat.mjs` adds
  `~/.claude/skills` at *user* scope, which is not trust-gated.
- **jiti writes transpiled extension code to a world-shared temp path** with predictable names; a poisoned
  cache entry is executed.
- **No `https` requirement on a provider `baseUrl`** — an `http://` value sends the API key in clear text.
- **`--api-key` puts a secret in the process command line**, readable by any local user. Prefer env or the
  credential store; consider rejecting the flag outright.
- **Terminal control sequences are not sanitised** on model-supplied bash commands, provider error bodies, or
  model text, enabling display spoofing and OSC 52 clipboard writes.
- **`strape auth print-api-key` / `print-bearer-token`** print live credentials to stdout and refresh-and-persist
  as a side effect — a one-line exfiltration primitive if the `bash` tool is ever auto-approved for the strape
  binary itself.

---

## Part 3 — accepted, with the reason

Not defects to fix; decisions to be aware of.

| Accepted | Why, and what compensates |
|---|---|
| **No sandbox; prompt injection unmitigated** | Upstream's documented design, and strape does not add one. Tools run with the user's privileges. Compensating control: containerise the process if you need that boundary (`packages/coding-agent/docs/containerization.md`), and keep `defaultProjectTrust: "ask"` |
| **Trust is per-directory and not re-confirmed when contents change** | Fixing it properly is an upstream design change. Hunk 11 closes the worst part: a project that was trusted when it had nothing to trust cannot escalate itself on `/reload` |
| **Tier C dependencies cannot be read** | `openai` ships largely generated code, `photon-node` ships WASM, `@mariozechner/clipboard` ships native binaries. Basis is integrity pinning + provenance + the high-scrutiny register, and the records say so rather than implying a source read |
| **26 of 50 dependency verdicts are `escalate`** | Each is a question a human must answer; the build gate blocks until they do. This is the gate working, not a backlog item to suppress |
| **`~/.strape/agent/models.json` can carry a `!shell-command` API key** | Requires local write access to the user's own config, which is inside any reasonable trust boundary. Recorded because if upstream ever adds *project-scoped* model config it becomes critical immediately |

---

## Part 4 — operational settings to apply now (no code change)

These cost nothing and mitigate several Part 2 items:

```json
{
  "defaultProjectTrust": "ask",
  "enableInstallTelemetry": false,
  "enabledModels": ["openai/gpt-*", "xai/grok-*", "gemini-openai/*"]
}
```

Plus: run via `strape/bin/strape` so `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` are set; install pinned
`rg`/`fd` with `provision-tools.mjs`; do not use `/share`; do not relocate `sessionDir` to a shared path; do not
run with a cwd under a world-writable ancestor; do not pass `--api-key`; reuse only skills you wrote.

Note that relocating `sessionDir` now costs more than it did: hunk 12 makes `~/.strape` private, and P2 is
only mitigated because transcripts sit under it. A `sessionDir` outside that tree loses that protection.

---

## How to work through Part 2

Each fix is a new hunk, so the rules in `strape/docs/HUNKS.md` apply: a written reason here, an entry in that
file, and an invariant in `verify-overlay.mjs` plus a regression test. Prefer a setting or the launcher over a
hunk where one exists.

And per `.claude/skills/source-audit`: **do not apply fixes while a review pass is running.** Batch them, then
re-verify what you touched — a verifier reading post-fix code will report the finding as never having been real.
