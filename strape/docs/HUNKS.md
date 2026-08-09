# strape's divergence from upstream pi

strape is a **vendor fork**: the tree is byte-identical to a reviewed upstream tag except for the sixteen
hunks below, plus the additive `strape/` directory and `.claude/skills/` (new files cannot merge-conflict).

Keeping this list short is the whole maintenance strategy. Before adding a seventeenth hunk, check whether a
setting, the launcher, or an extension can do the job instead.

Numbering is stable, not sequential: hunk numbers are cited across `strape/audit/` and in comments inside
upstream-owned source, so slots are never renumbered. Hunks 10 and 11 were originally the `auth` help text
and the interactive startup hint; both were merged into hunk 3 (same class), which freed slot 10 for the
self-update guard and slot 11 for the reload trust guard.

`node strape/scripts/verify-overlay.mjs` asserts every hunk is still in place, because a merge from upstream
can silently revert any of them. It runs in CI (`.github/workflows/strape-build.yml`). It is deliberately
**not** added to `.husky/pre-commit`: that file is upstream-owned, so wiring it there would cost another
hunk for a check CI already performs. Run it locally from your own hook if you want it earlier.

## Branch model

| Branch | Contents | Rule |
|---|---|---|
| `vendor` | pristine upstream, fast-forwarded to reviewed release tags | never edit; `git merge --ff-only <tag>` only |
| `main` | `vendor` + the sixteen hunks + `strape/` | **merge** `vendor` into it, never rebase |

Merging (not rebasing) means each conflict is resolved once and the resolution is recorded in history.
Rebasing 16 hunks over 2-5 upstream releases/week means re-resolving the same conflicts forever.

## The sixteen hunks

### 1. Rebrand — `packages/coding-agent/package.json`

```json
"piConfig": { "name": "strape", "configDir": ".strape" },
"bin": { "strape": "dist/cli.js" }
```

Upstream built this seam *for* forks (`packages/coding-agent/src/config.ts:487-496`). From these two fields it
derives `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME` (`.strape`), the agent dir (`~/.strape/agent`), and the
`STRAPE_CODING_AGENT_DIR` / `STRAPE_CODING_AGENT_SESSION_DIR` env var names. ~13 files consume those
constants instead of hardcoding, so help text, usage, process title, TUI title and HTML export all rebrand.

Deliberately **not** renamed: the npm scope (`@earendil-works/pi-*`, ~469 files, zero value for a fork that
never publishes) and the literal `PI_*` env vars (`main.ts:572-575`, `config.ts:369`, `config.ts:502-508` —
hardcoded strings; the launcher sets them, users never type them).

Side effect: `piConfig.name` flips `isOfficialDistribution()` false (`cli/startup-ui.ts:36-42`), which
disables the first-run wizard. That is fine — `strape/scripts/claude-compat.mjs` seeds settings instead.

### 2. Workspace trim — root `package.json`

Drops the five `packages/coding-agent/examples/extensions/*` workspaces. Free hardening: it removes `ssh2`
and `cpu-features` (native, node-gyp) from the dev tree. Verified to need **no lockfile change**.

### 3. Identity strings — seven files

The `piConfig` seam only reaches strings upstream actually wrote as `${APP_NAME}` / `${APP_TITLE}`. Everything
here was a bare literal, so a rebranded binary told users — and the model — that it was pi.

| File | Strings |
|---|---|
| `core/system-prompt.ts` | `inside pi,` → `inside strape,`; `Pi documentation` → `strape documentation`; and four more in the same block (`read pi docs`, `pi packages`, `pi topics`, `pi .md files`) |
| `cli/credential-print.ts` | `pi auth print-api-key …` in the usage block and the unknown-subcommand error — three strings |
| `modes/interactive/interactive-mode.ts` | the startup hint; the untrusted-project banner; the `/trust` confirmation; the uncaught-exception notice; the auth dialog's "configured outside pi"; the tmux `csi-u` hint |
| `cli/args.ts` | the `update` line of the top-level command table |
| `core/project-trust.ts` | the trust prompt itself — "This allows pi to load `.strape` settings…" |
| `main.ts` | the extension-load failure hint, `Start without extensions using "pi -ne"` |
| `package-manager-cli.ts` | the `update` help block (7 strings) and `Location of pi executable` |

**This hunk changes behaviour, not just cosmetics.** `system-prompt.ts` is what the model is told it is, and
before the sweep the prompt introduced itself as "strape documentation" and then referred to pi four times in
the same list — worse than either name used consistently.

Three of these (system-prompt, `auth` help, the interactive hint) were originally hunks 3, 10 and 11: three
numbers for one class, each found the same way — a person ran the command and read the output. No gate
produced any of them. They were merged into one hunk and the rest of the class swept in one pass, which is
also why slot 11 no longer exists and slot 10 was reused.

Pinned twice, deliberately: `verify-overlay.mjs` asserts the source literals (survives a stale `dist/`), and
`strape/scripts/rebrand-test.mjs` runs the built CLI and reads its actual output (survives upstream adding a
string no invariant knows about).

**Cost:** one added expected test failure. `test/system-prompt.test.ts:57` asserts the literal
`- When reading pi docs or examples, …`; it is recorded in `strape/audit/expected-test-failures.json`.

**Deliberately left as upstream's:**

- `core/session-manager.ts:905` — `Session file is not a valid pi session`. Three upstream tests assert this
  string exactly (`test/session-file-invalid.test.ts:60`, `test/session-manager/file-operations.test.ts:339,350`).
  Three more expected failures to rebrand an error that only appears on a corrupt session file is a bad trade;
  revisit if upstream ever stops asserting on the message.
- `PI_*` env var names and `pi.dev` URLs in `--help` — hardcoded by design (hunk 1), and the URLs are
  upstream's real endpoints.
- `@earendil-works/pi-*` imports, temp-file prefixes (`pi-bash`, `pi-output`, `pi-editor-`), and
  `SkillDiscoveryMode = "pi" | "agents"` — not user-facing.
- `modes/interactive/components/first-time-setup.ts` — says "Pi", but is unreachable: `shouldRunFirstTimeSetup`
  returns false because `isOfficialDistribution` is false for a fork (`cli/startup-ui.ts:115-122`).
- `modes/interactive/components/earendil-announcement.ts` — "pi has joined Earendil" is an easter egg making a
  true statement about upstream.
- `core/provider-attribution.ts:46-76` — sends `pi` identity headers, but only to OpenRouter, NVIDIA NIM,
  Cloudflare and opencode. None are in strape's provider scope, and it is gated on telemetry being enabled.

### 4. Provider SDK trim — `packages/ai/package.json`

Moves five SDKs from `dependencies` to `devDependencies`: `@anthropic-ai/sdk`,
`@aws-sdk/client-bedrock-runtime`, `@smithy/node-http-handler`, `@google/genai`, `@mistralai/mistralai`.

**The highest-leverage change in strape.** Measured with upstream's own generator: shipped closure
**143 → 56 packages**, install-script packages **2 → 0** (it removes `@google/genai`'s preinstall and
`protobufjs`'s postinstall along with the whole `@aws-sdk`/`@smithy` tree, `google-auth-library`, `jws`,
`ws`, `long`).

Safe because 0.84.0 lazy-loads provider SDKs: providers import `*.lazy.ts` wrappers
(`packages/ai/src/providers/anthropic.ts:1`), and upstream ships
`packages/ai/test/lazy-module-load.test.ts` asserting zero SDK loads on barrel import. They stay as
devDependencies so build, type-check and tests pass unchanged — which is what keeps this hunk cheap.

Conflicts only when upstream bumps those exact five versions; resolution is to take upstream's version
number in the `devDependencies` block.

**Gemini support does not change this hunk.** Gemini rides Google's **OpenAI-compatible endpoint**, declared in `models.json` as an `openai-completions`
provider (`strape/scripts/claude-compat.mjs --global` writes it). That reuses the `openai` client already in the
shipped closure and adds **zero packages**. The native route — `@google/genai`, which pi's built-in `google`
provider uses — was measured and rejected: it takes the shipped closure from **56 to 93 packages** and puts
install-script packages back from **0 to 2** (`@google/genai` preinstall, `protobufjs` postinstall), which would
also force hunk 5's empty allowlist open. Reach for it only if you hit a Gemini feature the compatibility layer
does not expose (thinking-budget config, safety settings, context caching), and treat it as a
dependency-review event.

### 5. Empty install-script allowlist — both generator scripts

`allowedInstallScriptPackages = new Map([])` in `scripts/generate-coding-agent-shrinkwrap.mjs` and
`scripts/generate-coding-agent-install-lock.mjs`.

**Required by hunk 4** — the generators hard-fail on a stale allowlist entry. It is also a control in its own
right: with an empty allowlist, any future dependency that grows a lifecycle script fails the build and
forces a human decision.

### 6. Vendored model catalog — `.gitignore` + `packages/ai/src/providers/data/`

Removing the `packages/ai/src/providers/data/` line from `.gitignore` and committing the 39 provider JSONs
(~600K) makes every build offline and turns model/pricing changes into a reviewable git diff instead of an
invisible network fetch from models.dev/OpenRouter at build time.

Refresh deliberately, not automatically: `npm run hydrate:model-data`, then review the diff.

### 7. Trust-boundary fix — `packages/coding-agent/src/main.ts`

```ts
const startupProjectTrusted = new ProjectTrustStore(agentDir).get(cwd) === true;
const startupSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: startupProjectTrusted });
```

The only hunk that exists because strape's own security review found a bug rather than because of branding or
dependencies. Upstream builds this manager before trust is resolved and `projectTrusted` defaults to `true`
(`core/settings-manager.ts:325`), so a never-trusted repository's `.strape/settings.json` can set `sessionDir`
and redirect the entire session transcript. Confirmed by dynamic repro; full write-up and the upstream
rationale in **`strape/docs/SECURITY-BACKLOG.md`** (Part 1, hunk 7).

Uses the *persisted* trust decision (no prompt) rather than a blunt `false`, so project-scoped `sessionDir`
keeps working for projects the user has actually trusted. Pinned by
`strape/scripts/trust-regression-test.mjs`, which also detects an upstream fix so this hunk can be retired
instead of carried forever.

### 8. Context-file symlink refusal — `packages/coding-agent/src/core/resource-loader.ts`

```ts
if (!options.allowSymlink && lstatSync(filePath).isSymbolicLink()) { /* warn + skip */ }
```

The second hunk that exists because strape's review found a bug. `statSync` follows symlinks, so upstream's
`isFile()` guard passes for `CLAUDE.md -> ~/.ssh/id_rsa`; context files load with **no trust prompt**, so a
cloned repo could make the harness read any file the user can read and put it in the system prompt sent to the
provider. Confirmed by repro. Rationale: **`strape/docs/SECURITY-BACKLOG.md`** (Part 1, hunk 8).

`allowSymlink: true` is passed only for the agent-dir lookup, because `claude-compat.mjs` links
`~/.claude/CLAUDE.md` there on purpose. Pinned by two assertions in `strape/scripts/compat-test.mjs` — one
that project symlinks stay refused, one that the global symlink keeps working.

Directly guards strape's headline feature: reusing `CLAUDE.md` would otherwise mean shipping this as a
selling point.

### 9. `--ignore-scripts` on runtime installs — `packages/coding-agent/src/core/package-manager.ts`

strape's build posture is `--ignore-scripts` everywhere with an empty install-script allowlist (hunks 4-5),
but extension and skill installs happen at **runtime** through `getNpmInstallArgs` /
`getGitDependencyInstallArgs`, where upstream passes no such flag — `grep -c "ignore-scripts"` over that file
returned **0**. A dependency's `postinstall` would therefore execute with the user's privileges, for a package
that was never in the reviewed closure at all, bypassing the entire dependency gate.

The flag is added to all four builders (npm, pnpm, bun, git-dependency). An extension that genuinely needs a
lifecycle script now fails loudly — the right outcome: that is a decision for a human, not a silent
install-time action.

### 10. No self-update on a vendor fork — `packages/coding-agent/src/package-manager-cli.ts`

```ts
const IS_OFFICIAL_DISTRIBUTION =
    PACKAGE_NAME === "@earendil-works/pi-coding-agent" && APP_NAME === "pi" && CONFIG_DIR_NAME === ".pi";
// …and getSelfUpdatePlan() returns { shouldRun: false } with an explanation when that is false.
```

`strape update` — where `self` is the **default** target when no argument is given — called
`getSelfUpdatePlan`, which fetches `https://pi.dev/api/latest-version` and then installs
`` `${latestRelease.packageName ?? PACKAGE_NAME}@${version}` `` **globally**. Two separate problems:

1. `packageName` is **server-supplied** (`utils/version-check.ts:78-80`), and the install branch fires
   *specifically when it differs* from `PACKAGE_NAME` (`packageName !== PACKAGE_NAME`). So whatever pi.dev
   returns is installed, with the user's privileges, entirely outside the reviewed closure — no shrinkwrap, no
   integrity hash, no `reviewed-deps` verdict. The `--ignore-scripts` posture of hunk 9 does not reach it.
2. Even the benign path replaces a build pinned to a reviewed tag with upstream's latest npm publish, which is
   what `strape/audit/UPSTREAM_PIN` exists to prevent (CLAUDE.md non-negotiable 3).

The guard runs **before** the network call, so a fork never contacts pi.dev at all, and it mirrors upstream's
own `isOfficialDistribution` triple (`cli/startup-ui.ts:26-42`) rather than importing it — that module pulls in
the whole TUI theme stack, and it means the guard retires by itself if strape is ever un-forked.

Not a launcher fix, deliberately: `PI_OFFLINE=1` does close this path, but a control that disappears the
moment someone runs `dist/cli.js` directly is not a control. `rebrand-test.mjs` asserts the refusal with
`PI_OFFLINE` **unset**, which is the test that distinguishes the two.

Rationale and the `PI_OFFLINE=0` split-state note in **`strape/docs/SECURITY-BACKLOG.md`** (Part 1, hunk 10).

### 11. Implicit project trust does not survive a reload — `core/resource-loader.ts`, `main.ts`, `interactive-mode.ts`

```ts
} else if (this.shouldRevokeImplicitProjectTrust()) {
    this.settingsManager.setProjectTrusted(false);   // …plus a warning naming the directory
}
this.trustRequiringResourcesAtLastLoad = hasTrustRequiringProjectResources(this.cwd);
```

The third hunk that exists because strape's review found a bug. A project with nothing trust-requiring in it
is trusted **with no prompt**, because there is nothing to trust (`core/project-trust.ts:50-52`). Upstream
re-resolves that decision only when the caller passes `resolveProjectTrust`, and no `/reload` caller does —
`core/agent-session.ts:2618` calls `this._resourceLoader.reload()` with no arguments, and so do
`modes/print-mode.ts:98` and `modes/rpc/rpc-mode.ts:342`.

So a repo that gains `.strape/settings.json`, `extensions/`, `skills/` or `SYSTEM.md` **during** the session
— a `git pull`, a branch switch, or the model writing them — has them loaded and *executed* at the next
`/reload` under the startup decision. `modes/interactive/interactive-mode.ts:4652` then writes that inherited
decision to the trust store as a permanent `trusted: true`, with no prompt. Confirmed twice independently,
and reproduced end-to-end by the regression test.

The guard fails closed: reload as untrusted, warn, and leave `/trust` as the deliberate path. It stands aside
in three cases, each pinned by its own assertion — `--approve`/`--no-approve` (the user stated a decision for
the run, forwarded from `main.ts` as `projectTrustOverride`), a persisted `trusted: true` for that path (the
user already said yes), and the first load (`main.ts` resolves trust properly there). Without those it would
be a blunt revoke-on-reload that punishes every project the user really did trust.

Living in the loader rather than in `/reload`'s handler covers print and rpc mode and the SDK at the same
cost, and means the check cannot be skipped by a caller that forgets it.

**The third file is the visibility half, and it was found by running a real `/reload`.** The loader's
`console.error` is a raw write to a screen the TUI owns, so it gets overdrawn mid-word and reads as
corruption; and `rebuildChatFromMessages()` clears the chat container during reload, which discards the
startup trust banner. Between them, a revoked project looked *trusted* in the TUI. The reload handler now
calls upstream's own `renderProjectTrustWarningIfNeeded()`, which renders in-frame and names the remedy. The
loader's line is kept, cut to one short clause, because print mode, rpc mode and the SDK have no TUI and it
is their only notice.

That gap was upstream's, not ours: `rebuildChatFromMessages()` has always dropped the banner on reload, so
*any* untrusted project looked trusted after `/reload`, with or without this hunk.

**Pinned by** seven assertions in `strape/scripts/trust-regression-test.mjs` — the escalation itself, both
stand-aside cases, the banner, a source pin, and a detector that reports when upstream starts resolving trust
in `reload()` so this hunk can be retired. The banner assertion is anchored *inside* the reload handler:
upstream already calls it once at startup, so a whole-file search passes against pristine vendor source and
proves nothing. The first version of it did exactly that and was caught by the negative test.

### 12. Agent directory is private — `config.ts`, `main.ts`

```ts
export function ensureAgentDirPermissions(agentDir: string = getAgentDir()): void
// mkdirSync(dir, { recursive: true, mode: 0o700 }) when missing; chmod 0700 when `mode & 0o077`.
```

`~/.strape` and `~/.strape/agent` are created by four writers with the ambient umask — `core/trust-manager.ts`
(trust.json and its lock dir), `core/settings-manager.ts`, `core/session-manager.ts` (recursively, so it
creates the parents too) and `migrations.ts`. That is 0755 at umask 022 and **0775, group-writable, at umask
002**, which is the default on Debian/Ubuntu and inside many container images. User-scope extensions load
from that directory with **no trust gate**, so on a umask-002 machine another local account can drop in an
extension that runs on the next start. `auth.json` gets a `chmod` after being written; nothing fixes a
directory, and nothing fixes anything that already exists.

One call from `main()`, placed before the bootstrap `SettingsManager`, so every later recursive `mkdirSync`
only creates leaves *inside* an already-0700 tree — which is why those four writers need no change and this
hunk stays two files instead of six. Both halves matter: creation covers a fresh install, the `chmod` covers
every install that already exists.

Only the **default** location is hardened up to its parent. With `STRAPE_CODING_AGENT_DIR` pointing
elsewhere, `dirname()` is a directory the user chose for their own reasons — `~/work/agent` would mean
chmodding `~/work` — so a custom agent dir is hardened alone. Failures warn rather than throw: a read-only or
exotic filesystem must not stop the agent from starting.

**Pinned by** `strape/scripts/agent-dir-perms-test.mjs` (11 assertions, including the umask-002 case, the
custom-location negative test, and the warn-don't-throw path) plus a `verify-overlay` invariant that checks
both halves and the call's position in `main()`.

### 13. Cross-origin redirects are refused — `core/http-dispatcher.ts`

```ts
function crossOriginRedirectGuard()   // undici interceptor, composed onto the global dispatcher
// throws on 301/302/303/307/308 whose Location leaves the request origin
```

undici's `fetch()` strips `Authorization`, `Cookie` and `Proxy-Authorization` when a redirect crosses origin
(`lib/web/fetch/index.js:1350-1358`) but, per spec, keeps every other header and **replays the request body**
on 307/308. Provider calls go through the global `fetch` that `undici.install()` replaces, so a DNS-hijacked
or compromised provider host answering 307 would receive the entire conversation. Bearer tokens are stripped;
`api-key`/`x-api-key` style headers are not — and the conversation is the sensitive part regardless.

Enforced at the dispatcher rather than with `redirect: "error"` on each provider fetch, for the reason hunk 11
and hunk 12 were also placed at their funnels: this module owns `setGlobalDispatcher` and `undici.install()`,
so one guard covers every caller, and a per-call-site flag is precisely what a future merge drops silently.
Note undici's own `stripHeadersOnCrossOriginRedirect` exists only for `undici.request`, not for `fetch`.

Deliberately **not** a hostname allowlist. An allowlist encodes today's provider set and breaks every
legitimate custom `baseURL` — Azure, gateways, self-hosted proxies. Origin-invariance is the actual property:
same-origin redirects still work, so ordinary `/v1` → `/v1/` behaviour is untouched, and only a redirect that
leaves the origin fails. An unparseable `Location` fails closed.

The handler is wrapped by forwarding each method explicitly rather than extending undici's internal
`DecoratorHandler`: deep-importing `undici/lib/handler/decorator-handler` would couple strape to a path
outside the package's public exports, and prototype-inheriting from the caller's handler would break undici's
private (`#`) fields by changing `this`. Throwing from `onResponseStart` is the supported failure path —
`core/request.js:344` wraps the call in `try`/`catch` and aborts the request with the thrown error.

**Pinned by** `strape/scripts/redirect-guard-test.mjs` (6 assertions driving two real loopback HTTP servers)
plus a `verify-overlay` invariant anchored to the `setGlobalDispatcher` region, not to the file at large. The
exfiltration assertion checks **what the attacker server received**, not merely that `fetch` rejected: a guard
that errored after replaying the body would still be a breach, and only the receiving end can prove otherwise.
Against pristine upstream the test reproduces the leak — the sink receives the request with the secret in it.

### 14. jiti's transpile cache is not in `/tmp` — `core/extensions/loader.ts`

```ts
fsCache: path.join(getAgentDir(), "cache", "jiti")
```

`createJiti` was called with only `{ moduleCache: false }`, so `fsCache` kept its default: **on**, pointing at
`os.tmpdir()/jiti`. jiti writes transpiled extension code there with umask-derived permissions (observed 775
dirs / 664 files under a world-writable `/tmp`) and later re-executes it via `vm.runInThisContext` on a bare
content-hash marker match. A local principal who can pre-create or write into that directory can plant code
strape runs with the developer's provider keys. Found by the dependency review's adversarial pass on jiti.

One line, and it reuses a control already built: `getAgentDir()` is the tree hunk 12 creates and repairs as
0700 before anything reads or writes there, so the cache is protected by its parent exactly as `sessions/` and
`bin/` are, with no mode dance of its own.

**Pinned by** `strape/scripts/jiti-cache-test.mjs`, which loads a real `.ts` extension through
`loadExtensions()` and then inspects the filesystem — asserting on the option literal would only prove the
line we just wrote is still there. It also mirrors real startup by calling `ensureAgentDirPermissions()`
first, since hunk 14's safety is a property of the composition, not of the path alone. A fourth assertion pins
the other jiti call-site guarantee: `transformOptions` must appear in **no** source file, because
`dist/babel.cjs` spreads a caller-supplied `...r.babel` after its safe defaults, leaving `babelrc`/`configFile`
overridable by anything that threads repo-controlled data in.

### 15. A mermaid parser throw does not break the message — `modes/interactive/components/mermaid.ts`

```ts
let art: ReturnType<typeof render>;
try { art = render(token.text); } catch { return token.raw; }
```

`render()` parses **model-controlled text** — any mermaid block the assistant emits — and this transformer runs
in the markdown path for every rendered message, with no `try`/`catch` anywhere up the chain. A throw there
does not cost one diagram; it breaks rendering of the message containing it.

grok-mermaid is deliberate about not throwing: it returns `null` plus a `warnings` array, and 60k fuzz cases
threw nothing at 0.2.2. This hunk exists because that is a property of **one reviewed version of a
single-maintainer parser we have chosen to keep taking updates from**, not a guarantee of the interface. The
fallback is the one already used for an unrenderable diagram — show the source — so the failure mode is a
diagram that appears as a code block, which is what a user would see for any unsupported diagram type anyway.

Recorded decision (2026-08-09): **the package was not vendored.** The dependency review recommended vendoring
it (`dep-review-v0.84.0.md`, grok-mermaid) on an estimate of ~1400 lines. The actual source is **4,546 lines**
— ~3,553 excluding a generated Unicode width table, dominated by `parse.ts` (1,150) and `layout.ts` (1,015).
Owning a 1,150-line parser over model-controlled input is a larger ongoing review burden than the exact
version pin, integrity hash and SLSA provenance already carry, so the pin stands and this three-line guard
covers the residual risk. Revisit if the package changes maintainer or the pin has to move under pressure.

**Pinned by** `strape/scripts/mermaid-throw-test.mjs`, which swaps the `grok-mermaid` specifier for a module
whose `render()` always throws, via an ESM resolve hook. Feeding pathological mermaid to the real parser would
pass with or without the guard — the precise shape of green-for-the-wrong-reason this repo keeps hitting — so
the test makes it throw and asserts the fallback. Against pristine upstream the probe process dies.

### 16. Lock reclamation window is deliberate — `trust-manager.ts`, `settings-manager.ts`, `auth-storage.ts`

```ts
lockfile.lockSync(path, { realpath: false, stale: 30_000 })
```

`proper-lockfile` reclaims a lock on **age alone** (`stale`, default 10s, `lib/lockfile.js:52`) — not on PID or
ownership. A holder that merely stalls past that window (slow disk, GC pause, `SIGSTOP`, laptop suspend, a
debugger breakpoint) has its lock taken over while it still believes it holds one. Only the *original* holder
is told, through `onCompromised`; the new acquirer proceeds normally, and neither writer knows it is racing.
strape locks `auth.json`, `trust.json` and `settings.json` with this, so two concurrent writers to the trust
store is a security-relevant outcome rather than a cosmetic one.

**Not a new number.** `auth-storage.ts`'s *async* path already chose `stale: 30_000` deliberately, with an
`onCompromised` handler. This hunk brings the three **synchronous** call sites in line with that decision. The
review that raised it described two sites; there are three — `auth-storage.ts:75`, its own sync path, was also
on the default. That is the shape of the bug: a deliberate value in one branch and the default in the branch
beside it.

Deliberately a window, not an absence: a lock that is never reclaimable turns any crash into a permanently
wedged config directory. The surrounding retry loops still give up after ~200ms, so `stale` governs only when
an **existing** lock is judged abandoned, never how long a caller waits.

**Pinned by** `strape/scripts/lock-stale-test.mjs`, which ages a real lock rather than waiting: 15s is stale
under the old default and fresh under 30s, so the two behaviours separate in milliseconds. It asserts both
directions — a slow holder is not robbed, and a genuinely abandoned lock (45s) *is* still reclaimed, because
"locking is now impossible" would also pass a fail-closed test. Behavioural coverage is the trust store; the
`verify-overlay` invariant covers all three sites and fails if **any one** of them drops back to the default.

## Adding a seventeenth hunk

Only with a written reason in `strape/audit/review-<pin>.md`, an entry here, an invariant in
`verify-overlay.mjs`, and a regression test. Take the next free number (17); do not renumber existing hunks.
Known candidates, both currently **rejected**:

- **Reorder context-file candidates so `CLAUDE.md` outranks `AGENTS.md`** (`core/resource-loader.ts:71`).
  One line. Rejected for now: cheaper to not keep both files in the same directory. Revisit if teams hit it.
- **Enforce `allowed-tools` in skill frontmatter.** Documented by upstream as experimental but *not
  implemented* — imported Claude Code skills are not tool-restricted. Real work, not a one-liner; for now it
  is an accepted risk recorded in the review, and the reason to reuse only skills you wrote.
