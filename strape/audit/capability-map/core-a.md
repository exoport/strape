# Core: agent loop, prompts, resources

## Scope (files + LOC)

`packages/coding-agent/src/core/*.ts`, files alphabetically `a`–`p` plus two files explicitly
called out in the task brief that sort after `p` but belong to the same theme
(`resource-loader.ts`, `skills.ts`). This is a flat, non-recursive glob: subdirectories such as
`core/extensions/`, `core/export-html/`, `core/tools/`, `core/compaction/` are **not** included
even though several in-scope files delegate real capability-bearing work to them (noted below).
31 files, 13,681 LOC.

| file | LOC | file | LOC |
|---|---|---|---|
| agent-session-runtime.ts | 441 | model-registry.ts | 157 |
| agent-session-services.ts | 221 | model-resolver.ts | 774 |
| agent-session.ts | 3342 | model-runtime.ts | 783 |
| auth-guidance.ts | 25 | models-store.ts | 146 |
| auth-storage.ts | 418 | output-guard.ts | 108 |
| bash-executor.ts | 156 | package-manager.ts | 2677 |
| cache-stats.ts | 164 | pi-manifest.ts | 34 |
| defaults.ts | 3 | project-trust.ts | 96 |
| diagnostics.ts | 15 | prompt-templates.ts | 285 |
| event-bus.ts | 33 | provider-attribution.ts | 97 |
| exec.ts | 107 | provider-composer.ts | 572 |
| experimental.ts | 3 | resource-loader.ts | 1096 |
| footer-data-provider.ts | 388 | skills.ts | 487 |
| http-dispatcher.ts | 111 | | |
| index.ts | 80 | | |
| keybindings.ts | 370 | | |
| messages.ts | 195 | | |
| model-config.ts | 297 | | |

Files with no meaningful capability surface (pure types/computation, no fs/net/exec/creds):
`defaults.ts`, `diagnostics.ts`, `event-bus.ts`, `experimental.ts`, `index.ts` (barrel export),
`cache-stats.ts`, `messages.ts` (types only), `model-resolver.ts` (pure model-list matching),
`auth-guidance.ts` (string formatting), `output-guard.ts` (stdout/stderr redirect, no I/O of its
own).

## What this area can do (prose)

This is the spine of the agent: `agent-session.ts` (3,342 LOC) owns the running conversation,
model calls, credential resolution for each request, compaction/summarization, and session
export; `agent-session-runtime.ts`/`agent-session-services.ts` wire up per-cwd services and
handle `/new`, `/resume`, `/fork`, and JSONL import (which copies an arbitrary user-specified
file into the session directory); `resource-loader.ts` and `package-manager.ts` together decide,
on every session (re)load, which extensions/skills/prompts/themes/AGENTS.md-CLAUDE.md files get
read off disk, whether npm/git packages get auto-installed (`npm install`, `git clone`, both via
argv-array child processes, never a shell string) into per-scope directories, and — critically —
gate essentially all *project*-scoped resource loading (extensions, skills, prompts, themes,
`.pi/SYSTEM.md`) behind `settingsManager.isProjectTrusted()`, i.e. an explicit "Trust this
project?" prompt (`project-trust.ts`). `model-runtime.ts`/`model-registry.ts`/
`provider-composer.ts`/`model-config.ts`/`auth-storage.ts` form the credential/model-provider
stack: they read/write `auth.json` and `models-store.json` under lock with `0600`/`0700`
permissions, resolve API keys and OAuth tokens per request, and expose a facade
(`ModelRegistry`) to loaded extensions that can read the API key for *any* configured provider
and register brand-new providers (arbitrary `baseUrl`, headers, and a custom `streamSimple`
function) once the extension is trusted. `bash-executor.ts`/`exec.ts` run child processes for
the bash tool and for extension/custom-tool exec helpers. `http-dispatcher.ts` installs the
process-wide `undici` HTTP dispatcher and proxy settings (from global, not project, config).
`skills.ts`/`prompt-templates.ts` load skill/prompt metadata and, on explicit user invocation
(`/skill:name`, `/promptname`), splice the full file body into the conversation as if it were
user content.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| bash-executor.ts:108 | `operations.exec(command, cwd, {...})` runs the bash-tool command (impl in out-of-scope `tools/bash.ts`) | user `!command`, model bash-tool call | bash tool's own approval/allowlist (out of scope) | Yes — command text comes from model output (T2) or user; this file only streams/truncates output |
| exec.ts:34-107 | `spawn(command, args, {shell:false,...})` generic exec helper "for extensions and custom tools" | extension/custom-tool code calling this helper | argv array, no shell interpolation; caller (extension) already had to be trust-loaded | Only via an already-trusted extension (T5) |
| footer-data-provider.ts:52,64 | `spawnSync`/`execFile("git", [fixed args], {cwd: repoDir})` to read current branch for the footer | periodic/startup UI refresh | fixed argv, no shell; `repoDir` derived from cwd walk, not attacker text | Low — repoDir path only |
| package-manager.ts (`runCommand`/`runCommandSync`/`spawnCommand`, ~L2611-2676) | runs `npm`/`git`/configured package manager with argv arrays | package install/update flows (see fs-write table) | see trust gating below | Yes, indirectly — package spec strings come from project/global settings |

### dynamic-code

No direct `eval`/`new Function`/`vm.*` in this scope. The real dynamic-code capability
(extension module loading) lives in `core/extensions/loader.ts`, which is **out of the flat
`*.ts` scope** but is invoked from `resource-loader.ts` (`loadExtensionsCached`,
`loadExtensionFromFactory`) — see "Capabilities found by reading" below.

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| http-dispatcher.ts:81-111 | `configureHttpDispatcher()` installs a process-global `undici.EnvHttpProxyAgent` and (conditionally) replaces `globalThis.fetch` via `undici.install()` | app startup (main.ts, out of scope) | none needed — sets policy, not itself a request | No — timeouts/allowH2 hardcoded |
| http-dispatcher.ts:45-50 | `applyHttpProxySettings()` sets `process.env.HTTP_PROXY`/`HTTPS_PROXY` from configured `httpProxy` | startup, reads `bootstrapSettingsManager.getGlobalSettings().httpProxy` | value comes from **global** settings only (`~/.pi/settings.json`), never project settings (verified via grep in `main.ts`) | No — a malicious repo cannot set this and hijack outbound API traffic |
| provider-attribution.ts:44-97 | Adds attribution headers (`HTTP-Referer`, `X-OpenRouter-*`, opencode session id) to outbound model requests | every request to specific provider hosts | `isInstallTelemetryEnabled` gates the attribution set (not the session-id header) | No secret material; session id is low sensitivity |
| model-runtime.ts (via `withRemoteCatalog`, imported from out-of-scope `remote-catalog-provider.ts`) | fetches a remote model-catalog JSON per builtin provider | model refresh (`allowNetwork` gated) | `PI_OFFLINE` env / `allowModelNetwork` option | Not attacker-influenced; informational only |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| auth-storage.ts:57,63-64,105-106,187-188 | Creates `auth.json` (`mkdir 0700` / `write 0600` / `chmod 0600`), same pattern for every credential write | login/logout/setRuntimeApiKey | `proper-lockfile` file lock around every read-modify-write; explicit `chmod 0600` after every write (belt-and-suspenders vs. umask) — **this is the CVE-2026-54327 fix pattern, verified present** | No — path is fixed under agentDir |
| agent-session-runtime.ts:369,380 | `mkdirSync(sessionDir)`, `copyFileSync(resolvedPath, destinationPath)` for `/import <file.jsonl>` | explicit user `/import` command | destination is under the session dir; source must already exist | User-supplied path only |
| agent-session.ts:3256,3278 | `mkdirSync`/`writeFileSync` for `exportToJsonl()` (full session, including tool outputs, to a `.jsonl` file) | explicit user export | writes with default (umask) perms, not chmod-restricted like auth.json | Content can include anything the model/tools produced during the session |
| package-manager.ts:217-218 | `getExtensionTempFolder()`: `mkdir 0700` + `chmod 0700` under `agentDir/tmp/extensions` (not shared OS tmpdir) | any npm/git package install/temporary-source refresh | mode 0700 + `resolveManagedPath()` path-traversal guard (throws if resolved path escapes root) — **this is the CVE-2026-54328 fix pattern, verified present** | Indirectly, via package source strings |
| package-manager.ts:1819-1994 (install/update/remove for npm & git sources) | `mkdirSync`, `rmSync(recursive)`, `writeFileSync` of `package.json`/marker files/`.gitignore` under the resolved install root | install/update/remove flows | project-scope writes gated by `assertProjectTrustedForScope()` (throws if project untrusted); user/temporary scope always allowed (user's own machine) | Project-scope package *identity* (source string) is attacker-influenceable only after project trust is granted |
| bash-executor.ts:69-70 | `createWriteStream(join(tmpdir(), "pi-bash-<16 hex>.log"))` — full (untruncated) bash stdout/stderr spill file | any bash command whose output exceeds the truncation threshold | filename uses 16 hex chars of `randomBytes(8)` (unguessable → not the predictable-path CVE pattern) but the file is **not chmod'd**; created with default `createWriteStream` mode (umask-dependent, typically world-readable 0644) in the **shared** OS tmpdir, unlike every other secret-adjacent file in this codebase which is chmod'd 0600/0700 | See "Suspicious" below — T3/T4 relevant |

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| auth-storage.ts (`AuthStorage.read`, ~L353-359) | Reads a stored credential and, for `api_key` type, resolves `credential.key` via `resolveConfigValue()` — which (in out-of-scope `resolve-config-value.ts`) executes the value as a **shell command** if it starts with `!` | every model request needing that provider's key | requires the value to already be attacker-set inside `auth.json`, which is itself 0600/user-owned — not a new attack surface by itself, but see "missed by sweep" below | Only if attacker already has write access to the user's own auth.json (already game-over) |
| agent-session.ts:409-469 (`_getRequiredRequestAuth`/`_getSummarizationRequestAuth`) | Resolves `apiKey`/`headers`/`env`/`baseUrl` for the active model and sends them with every LLM request; `baseUrl` can be overridden by whatever `ModelRuntime.getAuth()` returns | every turn / every summarization call | relies on `ModelRuntime`/`provider-composer.ts` composition; a trusted extension can register a provider that supplies its own `baseUrl` | Yes, once an extension/project is trusted (T5) |
| model-registry.ts:64-93,119-125 (`ModelRegistry`, "Synchronous compatibility facade **exposed to extensions**") | `getApiKeyForProvider(provider)` returns the raw resolved API key **for any configured provider**, not just the active one; `registerProvider()` lets an extension supply `apiKey`/`baseUrl`/`headers`/a custom `streamSimple` fetch function | any loaded extension calling the SDK (impl. in out-of-scope `core/extensions/`) | Gated only by the project-trust decision that got the extension loaded in the first place | **High** — this is the concrete blast radius of "yes, trust this project": every stored provider credential becomes readable, and outbound model traffic can be redirected |
| model-runtime.ts:510-682 (`synchronizeCredentialState`, `setRuntimeApiKey`, `login`/`logout`) | Writes/removes credentials via `RuntimeCredentials`→`AuthStorage`, keeping the in-memory model snapshot in sync | `/login`, `/logout`, extension calls | Wraps `AuthStorage` (see above); errors surface as `CredentialSynchronizationError` rather than silently losing state | User-driven; OAuth flows delegate `login()`/`refreshToken()` to provider or **extension-supplied** `ExtensionOAuthConfig` (provider-composer.ts) |
| provider-composer.ts:33-71,419-481 | `ProviderConfigInput`/`ExtensionOAuthConfig` — the extension "registerProvider" API surface: arbitrary `baseUrl`, `apiKey`, `headers`, `authHeader`, and OAuth `login/refreshToken/getApiKey` callbacks | extension registration at session-services build time | none beyond "extension is loaded" (i.e. project/user trust) | Yes, once trusted |
| model-config.ts:193-204 | `models.json` schema allows `apiKey` as a plain string (or, via `resolve-config-value.ts`, a `!command` or env-var reference) per provider | global `models.json` load | Path is fixed at `join(getAgentDir(), "models.json")` — **global**, not project — confirmed not project-overridable in this scope | No — user's own global file only |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| package-manager.ts:6-23 (`getEnv`) | On Linux, if `process.env` looks empty, falls back to reading `/proc/self/environ` directly | package-manager sync command execution | best-effort fallback for a stripped-env launcher scenario; not attacker-reachable | No |
| package-manager.ts:44-47,212 | `PI_OFFLINE` toggles all network installs/updates off; `getHomeDir()` prefers `process.env.HOME` | startup / any install call | n/a | No |
| http-dispatcher.ts:48-49 | Sets `HTTP_PROXY`/`HTTPS_PROXY` from **global-only** settings (see network table) | startup | see above | No |
| model-runtime.ts:194 | `process.env.PI_OFFLINE === undefined` decides whether network-backed model refresh is even attempted | ModelRuntime construction | n/a | No |
| footer-data-provider.ts:84 | WSL detection via `WSL_DISTRO_NAME`/`WSL_INTEROP` to decide whether to poll instead of `fs.watch` | startup | n/a | No |
| experimental.ts:2 | `PI_EXPERIMENTAL === "1"` feature-flag gate | any call site checking experimental features | n/a | No |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| auth-storage.ts:278,413 | `JSON.parse` of `auth.json` content | every credential read | file is 0600, user-owned | No |
| model-config.ts:261 | `JSON.parse(stripJsonComments(content))` of global `models.json`, then **typebox-schema validated** (`validateModelsConfig.Check`) before use | ModelRuntime creation | schema validation rejects malformed/extra-shaped input; path is global-only | No |
| models-store.ts:62 | `JSON.parse` of `models-store.json` (cached provider catalog) | model refresh | same lock/perm pattern as auth.json (reuses `FileAuthStorageBackend`) | No |
| keybindings.ts:332 | `JSON.parse` of user `~/.pi/keybindings.json`, wrapped in try/catch, type-checked (`typeof parsed !== "object"` → discarded) | startup / reload | user's own file only | No |
| package-manager.ts:1477,1493,1859,2031 | `JSON.parse` of npm `package.json` manifests and `npm/pnpm list --json` output during install/update reconciliation | install/update flows | consumed for version/dependency bookkeeping, not executed | Indirectly, package content is attacker-influenced once a malicious package is installed (already implies trust) |
| pi-manifest.ts:16-34 | `JSON.parse` of any package's `package.json`, extracts a `pi: { extensions, skills, prompts, themes }` manifest telling the loader which files inside that package to treat as extensions/skills/etc. | package resolution (npm/git/local) | wrapped in try/catch returning `null` on any shape mismatch; does not itself execute anything | This is exactly the file an installed malicious package uses to point the loader at its payload — but only reached after that package was already installed (trust already spent) |

### trust

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| project-trust.ts:46-96 (`resolveProjectTrusted`) | Central "Trust project folder?" decision: checks override → extension-supplied `project_trust` handler → stored decision → `defaultProjectTrust` setting (`always`/`never`/`ask`) → interactive `ctx.ui.select()` prompt | first resource load per cwd (or whenever `hasTrustRequiringProjectResources()` is true) | Prompt text explicitly says this "allows pi to load `.pi` settings and resources, install missing project packages, and execute project extensions" — this is the single approval gate for **all** project-scoped code execution in this area | The *cwd* is attacker-influenced (a malicious repo), the *decision* is not — requires a human (or a pre-set `defaultProjectTrust`/remembered decision) |
| package-manager.ts:1714-1718 (`assertProjectTrustedForScope`) | Throws before any project-scope package install/uninstall/storage access if `!settingsManager.isProjectTrusted()` | every project-scope package op (~6 call sites: L981,1003,2003,2044,2083,2109) | Hard `throw`, not a soft warning | N/A — this is the guard itself |
| package-manager.ts:2330-2446 (`addAutoDiscoveredResources`) | Auto-discovers `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes` under the project dir | resource-loader `.resolve()` | Extensions/skills wrapped in `if (projectTrusted)`; prompts/themes in a second `if (projectTrusted)`; the `.agents/skills` ancestor-dir variant achieves the same gating by computing an **empty list** (`projectAgentsSkillDirs = projectTrusted ? [...] : []`) rather than an `if` — functionally equivalent but structurally easy to break in a future edit without an explicit guard visible at the write site | Verified consistent, but worth a regression-test flag (see Questions) |
| resource-loader.ts:1022-1048 (`discoverSystemPromptFile`/`discoverAppendSystemPromptFile`) | Project `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` (which fully replace/append to the system prompt) are only read `if (this.settingsManager.isProjectTrusted())` | session (re)load | Same trust gate | Gated |
| resource-loader.ts:118-156 (`loadProjectContextFiles`) | **Not** trust-gated: `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` are read from every ancestor directory up to filesystem root, and from the global agent dir, regardless of project-trust state | every session (re)load | None — by upstream design (T1 says prompt injection is unmitigated by design; this is the concrete mechanism) | **Yes, directly** — this is the primary T1 ingestion point in this area |
| skills.ts (`formatSkillsForPrompt`) | Injects skill *name+description+path* (not body) into the system prompt for every loaded skill, telling the model to "use the read tool to load a skill's file" | session (re)load, if skills are loaded | Only trusted-scope skills reach this (see above); output is XML-escaped | Name/description text is attacker-controlled once a skill is loaded |

## Dismissed sweep hits (with reason)

- `agent-session-runtime.ts:262` (`process-exec`, `"async fork("`) — this is `AgentSessionRuntime.fork()`, a session-tree/branch operation, not `child_process.fork()`. No process is spawned.
- `agent-session.ts:851` (`process-exec`) — matched inside a string literal/error message (`"...ctx.fork(), ctx.switchSession()..."`) describing stale-extension-context rules; not code that forks anything.
- `agent-session.ts:213,215` (`trust`) — JSDoc comments about a tool-name allowlist/denylist parameter, unrelated to project-trust logic. Matched on "allow"/"deny" vocabulary only.
- `keybindings.ts:239` (`trust`) — `selectConfirm: "tui.select.confirm"`, a keybinding action name; matched on "confirm", unrelated to trust decisions.
- `model-config.ts:196`, `model-registry.ts:20`, `model-runtime.ts:83`, `provider-composer.ts:49` (`credentials`, various `apiKey?: string;`) — these are TypeScript field declarations, not credential material or an operation; kept as supporting context in the inventory table above rather than a per-line finding.
- `model-runtime.ts:15,56,68,89-104,130,153,160,171,189,283,306,510,512,528,548,549,553,554,558` etc. (`credentials`) — many of these are type imports, field names, or method names containing "credential"/"Credential"; the operationally meaningful subset is summarized once in the credentials table (setRuntimeApiKey/login/logout/synchronizeCredentialState) rather than listed 38 times.
- `provider-attribution.ts:46` (`network`, `"HTTP-Referer": "https://pi.dev"`) — a static attribution header value, not a network call site; the actual dispatch happens elsewhere (pi-ai SDK, out of scope). Kept in the network table for context, not double-counted as a separate capability.
- `package-manager.ts:1` (`process-exec`, `import type { ChildProcess, ... } from "node:child_process"`) — type-only import; the real capability is `spawnProcess`/`spawnProcessSync` from `../utils/child-process.ts` (out of scope) invoked later in the file (covered in the process-exec table).

## Capabilities found by reading, missed by the sweep

- **Extension "register a model provider" API** (`agent-session-services.ts:157-181`, `applyExtensionFlagValues`/`pendingProviderRegistrations`/`pendingNativeProviderRegistrations`): a loaded extension can call back into `modelRuntime.registerProvider()`/`registerNativeProvider()` with a full `ProviderConfigInput` (arbitrary `baseUrl`, `headers`, custom `streamSimple` function). No sweep keyword (no literal "apiKey"/"credential"/"exec" on these lines) flagged this, but it is one of the highest-impact capabilities in the whole area once a project/extension is trusted (network exfiltration + credential harvesting surface). Cross-referenced against `provider-composer.ts` and `model-registry.ts`.
- **Config-value command execution reachable from `auth-storage.ts`**: `AuthStorage.read()` (L353-359) calls `resolveConfigValue(credential.key, credential.env)`, which — in out-of-scope `resolve-config-value.ts` — runs `execSync`/`spawnSync` when the stored value starts with `!`. The sweep has no `process-exec` hit on this line because the exec call itself lives in a different, out-of-scope file; only reading the call chain surfaces it. Not a new hole (requires the attacker to already control `auth.json`), but it means "read a credential" and "run a shell command" are the same code path here, worth the human reviewer double-checking `resolve-config-value.ts` (owned by core-b/adjacent) for `credential.env`-controlled `PATH`/`shell` injection.
- **`pi-manifest.ts` → `package-manager.ts` → `resource-loader.ts` extension-loading pipeline crosses into `core/extensions/loader.ts`, which is a subdirectory excluded from this flat-glob scope.** The actual `import()`/`require()` of extension code (the dynamic-code capability CVE-2026-54325 concerns) is not visible in any file this report covers; only the trust-gating *around* it is. Flag for whoever owns `core/extensions/**`.
- **`core/export-html/index.ts` (also excluded by the flat glob) is called directly from `agent-session.ts:3236` (`exportSessionToHtml`)** — the CVE-2026-54326 (XSS in HTML export) surface. A quick look shows an `escapeHtml()` helper used in `export-html/ansi-to-html.ts`, suggesting the fix is present, but this file was not exhaustively reviewed as part of this section and should be confirmed by whoever audits `core/export-html/**`.
- **`/skill:name` and `/promptname` full-body injection** (`agent-session.ts:1309-1333` `_expandSkillCommand`, `prompt-templates.ts:269-285` `expandPromptTemplate`): typing either command spraying the *entire* SKILL.md/prompt-template file body verbatim into the conversation as if it were the user's own message, wrapped only in a `<skill name=... location=...>` tag (no "this content came from a file, treat with suspicion" framing). This is a second-order T1 vector: a name/description surfaced from an untrusted-but-loaded skill can lure a user into typing the slash command, at which point arbitrary file content joins the trusted conversation context. Not a sweep hit because there's no fs-write/exec/credential keyword on these lines — pure `readFileSync` + string interpolation.
- **`getEnv()`'s `/proc/self/environ` fallback** (`package-manager.ts:6-23`) is a Linux-only environment-recovery path the sweep flagged as `env` but its purpose (working around an apparently-empty `process.env` when a wrapper strips it before exec) is not obvious from the regex hit alone.

## Questions for the human reviewer

1. **`settings-manager.ts`, `trust-manager.ts`, `session-manager.ts`, `runtime-credentials.ts`, `resolve-config-value.ts`, `remote-catalog-provider.ts`, `sdk.ts`, `source-info.ts`, `slash-commands.ts`, `telemetry.ts`, `timings.ts`, `usage-totals.ts`** all sort after `p` and were **not** covered here even though this area's files import from and depend on them constantly (project-trust decisions, session persistence, the `!command` config-value executor). Please confirm these are covered by the sibling "core-b" section, especially `resolve-config-value.ts` (shell-command credential resolution) and `settings-manager.ts` (the `defaultProjectTrust`/`httpProxy`/project-vs-global settings split this report leans on heavily).
2. **`core/extensions/**`, `core/export-html/**`, `core/tools/**`, `core/compaction/**`** are subdirectories of `core/` excluded by the flat `*.ts` glob but are where the actual dynamic-code loading (CVE-2026-54325 lineage), HTML export escaping (CVE-2026-54326 lineage), and bash/other tool execution live. This report can only vouch for the trust-gating *around* these; someone needs to own a direct review of the subdirectories themselves.
3. **`bash-executor.ts:69-70`** writes full (untruncated) bash command output to a randomly-named but **not permission-restricted** file in the shared OS tmpdir. Given the codebase's otherwise consistent discipline (auth.json, models-store.json, extension temp dir all explicitly `chmod`'d 0600/0700), please confirm whether this is intentional (output is "just command output," not credentials) or an oversight — on a shared multi-user machine (T3) any command whose output contains a secret (e.g. `printenv`, `cat .env`, a misconfigured `git config -l`) leaves that secret world-readable in `/tmp` until cleanup.
4. **`project-trust.ts`'s `defaultProjectTrust: "always"` setting** — confirmed to live in *global* settings only in this pass, but please double check in core-b that no project-scope setting or CLI flag can silently flip a repo's own trust decision before the human sees the prompt.
5. The dead `includeDefaults: true` code path in `skills.ts`/`prompt-templates.ts` (unconditional `.pi/skills`/`.pi/prompts` loading, unreachable from the only real caller in `resource-loader.ts`) — confirm no other in-tree or extension-facing caller re-enables it and bypasses the trust gate that `package-manager.ts` otherwise enforces.
