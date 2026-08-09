# Extension system

## Scope (files + LOC)

`packages/coding-agent/src/core/extensions/`
- `index.ts` (186) — public re-export surface (`@earendil-works/pi-coding-agent` extension API)
- `loader.ts` (737) — extension discovery, module loading (jiti), extension API/runtime construction
- `runner.ts` (1236) — `ExtensionRunner`: event dispatch, context construction, provider (un)registration wiring
- `types.ts` (1722) — all extension-facing type/interface declarations (the "SDK surface")
- `wrapper.ts` (45) — adapts `RegisteredTool` → `AgentTool` for the agent-core tool loop

`packages/coding-agent/src/extensions/` (built-in, non-user-authored extensions bundled with the app)
- `index.ts` (4) — `builtInExtensions` registry, always loaded at startup
- `llama/index.ts` (228) — `/llama` command: manage a local llama.cpp router (load/unload/download models)
- `llama/provider.ts` (150) — registers the `llama.cpp` model provider (auth, refreshModels, stream)
- `llama/client.ts` (332) — HTTP/SSE client for the llama.cpp server (`/models`, `/models/load`, `/models/sse`, …)
- `llama/huggingface.ts` (158) — Hugging Face search/details client + local HF token discovery
- `llama/ui.ts` (542) — TUI overlay for `/llama` (no capability sinks; pure rendering)

Total: 10 files, 5340 LOC.

Out of scope but load-bearing context read to establish accurate triggers/guards (not audited here, flagged for the owning section instead): `core/resource-loader.ts`, `core/package-manager.ts`, `core/settings-manager.ts`, `core/resolve-config-value.ts`, `core/project-trust.ts`, `main.ts`, `packages/agent/src/agent-loop.ts`.

## What this area can do (prose, 1 para)

This is the plugin/SDK layer that turns arbitrary local `.ts`/`.js` files into first-class, in-process extensions of the harness: `loader.ts` discovers files under project-local `.pi/extensions/`, the global `~/.pi/agent/extensions/` (or configured agent dir), and any explicitly-configured paths, then uses `jiti` to transpile-and-`import()` them directly into the running Node/Bun process — this is unsandboxed dynamic code execution by design, with the loaded module getting a bundled view of the harness's own internals (`pi-agent-core`, `pi-tui`, `pi-ai`, and the coding-agent package itself). Once loaded, an extension's factory function receives an `ExtensionAPI` (`types.ts`) that can: register LLM-callable tools whose `execute()` runs with full Node privileges and no built-in approval gate; register/override model providers including arbitrary `baseUrl`, custom headers, an `apiKey` string that can itself trigger shell-command execution (`!cmd` syntax, resolved by `core/resolve-config-value.ts`) or OAuth login/refresh flows; intercept and *mutate in place* every tool call's arguments and every tool result's content before they reach approval/execution or the model, via `tool_call`/`tool_result`/`context`/`before_provider_request`/`before_provider_headers` hooks; run shell commands via `ctx.exec()`; and drive the TUI (custom editors, footers, dialogs, raw terminal input). `runner.ts` is the dispatcher that fans agent-lifecycle events out to all loaded extensions' handlers and lets any one of them veto (`block`) a tool call or a session-tree operation. Trust gating for *which* extensions get loaded from the project directory lives outside this scope (`resource-loader.ts` + `package-manager.ts`, gated by `SettingsManager.isProjectTrusted()`); this scope's own `discoverAndLoadExtensions()` export performs no trust check of its own. A bundled, always-on extension (`src/extensions/llama`) additionally talks to a local (by default) llama.cpp server and to `huggingface.co` to manage local model downloads, reading an HF token from disk/env along the way.

## Capability inventory

### dynamic-code

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| loader.ts:444-455 `createJiti(...).import(extensionPath)` | Transpiles and dynamically imports an arbitrary `.ts`/`.js` file as a full ES module, then calls its default export as `(pi: ExtensionAPI) => void` | Every extension load: startup, `/reload`, session replacement | Only the file-discovery step (below) gates *which* paths reach this call; once reached, execution is unconditional | Yes — the module's entire top-level code and factory body run with full process privileges. Content is attacker-influenced whenever attacker can place a file under a discovered extensions dir (see loader.ts:610-737) |
| loader.ts:50-74 `VIRTUAL_MODULES` | Gives every loaded extension direct `import`-access to the harness's own bundled internals (`pi-agent-core`, `pi-tui`, `pi-ai` + oauth + all providers, the whole `pi-coding-agent` package) | Same as above (resolved per-import inside the jiti sandbox config) | None — intentional SDK surface | N/A (amplifies what a loaded extension can already do; not a new entry point) |
| loader.ts:76,92-94 `createRequire`, `require.resolve("typebox"...)` | Resolves on-disk paths for jiti's Node-mode alias table | Module init (once) | Fixed package names only, not attacker input | No |
| loader.ts:610-684 `discoverExtensionsInDir` / `resolveExtensionEntries` | Enumerates `*.ts`/`*.js` files and one level of subdirectories (`index.ts`/`index.js`, or a `package.json` `"pi.extensions"` manifest) under a directory, feeding the paths to the loader above | Called for project-local `.pi/extensions/`, global `agentDir/extensions/`, and configured directories, on every `discoverAndLoadExtensions()` call | None inside this file — see "Questions for reviewer" below regarding trust enforcement living entirely in the caller | Yes for the project-local directory: any process that can write into a project's `.pi/extensions/` (malicious repo checkout, T1) controls what gets executed *if* the caller decides to trust the project |

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| loader.ts:358-361 `api.exec()` → `execCommand(command, args, cwd, options)` | `pi.exec(command, args, options)` — spawns a child process (`child_process.spawn`, `shell:false`, so no shell-metacharacter injection from this call itself) | Called explicitly by extension code (event handler, command handler, or tool `execute()`) | `runtime.assertActive()` only (session-liveness check, not a permission check) | Extension code decides `command`/`args`; if those embed model-tool-call input verbatim, a malicious/compromised model (T2) could steer what an otherwise-benign extension executes |
| types.ts:1328 `exec(command, args, options?): Promise<ExecResult>` | Type declaration for the same capability | — | — | — |

Dismissed as false positives for this class: loader.ts:210 and runner.ts:544 (`invalidate()` default message text) and types.ts:368 (`fork(entryId, ...)`) — all three matched the sweep's regex on the word "fork", but refer to **session-tree fork** (`ExtensionCommandContext.fork()`), not process forking.

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `types.ts` `ProviderConfig.baseUrl`/`headers`/`streamSimple` (registerProvider, ~1360-1482) | Lets an extension redirect an **existing** built-in provider's `baseUrl` (e.g. `anthropic`) to any URL, or register a brand-new provider, with custom headers and a custom `streamSimple` transport | `pi.registerProvider(name, config)` called from extension init or any handler | None beyond "the extension is loaded" | If the extension itself is compromised/malicious (T2/T5-adjacent supply chain), this is a documented, first-class way to silently MITM all LLM traffic (prompts, file contents pasted into context, and the resolved API key if `authHeader:true`) to an attacker endpoint |
| runner.ts:1016-1079 `emitBeforeProviderRequest` / `emitBeforeProviderHeaders` | Lets extensions read and rewrite the outgoing provider request payload and headers (including `Authorization`) immediately before every LLM call | Every provider request, if any extension registered `before_provider_request`/`before_provider_headers` handlers | None — handlers run unconditionally, return value replaces the payload/headers | Same trust boundary as above: a loaded extension can read the resolved API key/headers here (T4 exfil primitive) and/or tamper with the request |
| llama/client.ts:171,216 `fetch(this.serverUrl + path, ...)` | Talks to the configured llama.cpp server (`/models`, `/models/load`, `/models/unload`, `/models/sse`) | User runs `/llama` and selects load/unload/download, or `refreshModels()` runs on model-catalog refresh | Server URL defaults to `http://127.0.0.1:8080`; user must have run `/login llama.cpp` or set `LLAMA_BASE_URL` to point elsewhere | Only if user configures a non-default `LLAMA_BASE_URL` / stored credential; not directly repo-content-controlled |
| llama/huggingface.ts:5,76 `fetch(https://huggingface.co + path, ...)` | Search/details lookups against the Hugging Face API, with `Authorization: Bearer <HF token>` if one is found | User runs `/llama` → "download model" | Fixed host (`huggingface.co`), 15s timeout | No (fixed host); token exfil risk is to the legitimate HF API only |
| llama/index.ts:145 (string literal `https://huggingface.co/...`) | Just a help-text URL shown in a confirmation dialog for gated models | Download flow, gated repo | — | Not a real network call; informational only |
| llama/provider.ts:14,76,79 `DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080"` | Default/loopback llama.cpp endpoint, overridable via `LLAMA_BASE_URL` | Provider auth resolution | Loopback default | No |

The bundled llama.cpp provider (`src/extensions/index.ts` → `builtInExtensions`) is **always loaded** for every session (not opt-in, only "hidden" from the extension list UI) via `main.ts:530`; its network surface is inert until the user runs `/login llama.cpp` or `/llama`.

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| types.ts:1438-1482 `ProviderConfig.apiKey` / `.oauth.{login,refreshToken,getApiKey}` | Extension supplies an API-key string or a full OAuth login/refresh implementation for a registered provider | `pi.registerProvider()` | The `apiKey` string is resolved later by `core/resolve-config-value.ts` (out of scope): a literal, an `$ENV_VAR`/`${ENV_VAR}` reference, **or**, if it starts with `!`, a shell command whose stdout becomes the key | The extension author controls this string; if it embeds untrusted data (e.g. copied from a tool result) a `!`-prefixed value would execute a shell command — see "found by reading" below |
| runner.ts:1050-1079 `emitBeforeProviderHeaders` | Extensions observe/mutate the final HTTP headers sent to the model provider, including a resolved `Authorization: Bearer <key>` | Every provider request | None | Loaded extension can read live API keys/tokens in-flight (T4) |
| llama/client.ts:158-168,215 `apiKey` field, `Authorization: Bearer` header | llama.cpp server credential | `/login llama.cpp`, `/llama` actions | Stored via normal credential store | No |
| llama/huggingface.ts:46-61,74 `findHuggingFaceToken()` | Reads `HF_TOKEN` env, or a token file at `HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, or `~/.cache/huggingface/token`, then sends it as `Authorization: Bearer` to `huggingface.co` | `/llama` → download model | Fixed, well-known HF token locations (matches official `huggingface_hub` conventions); fixed destination host | Not attacker-controlled in the harmful sense — same trust model as official HF tooling |
| llama/provider.ts:103 `credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local"` | Resolves the llama.cpp API key from stored credential, env var, or falls back to literal `"local"` | Auth resolution for the llama provider | — | No |
| types.ts:26 `OAuthCredentials` import | Type only | — | — | — |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| llama/client.ts:236 `JSON.parse(data) as LlamaModelEvent` | Parses one SSE frame from the llama.cpp server's `/models/sse` stream | While `watch()` is active during load/download | Wrapped in `try/catch`; result is shape-checked (`typeof event.model === "string" && typeof event.event === "string"`) before use, and malformed events are silently dropped | Only if the configured llama.cpp server is itself malicious/compromised (the user already pointed the client at it); no code execution path from the parsed object, only status-string comparisons |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| llama/huggingface.ts:46 `findHuggingFaceToken(env = process.env)` | Reads `HF_TOKEN`, `HF_TOKEN_PATH`, `HF_HOME`, `XDG_CACHE_HOME` | `/llama` download flow | — | No |
| llama/provider.ts:76,79 `process.env.LLAMA_BASE_URL` | Placeholder/default during `/login llama.cpp` | Login flow | — | No |

Not flagged by the sweep but present: `llama/provider.ts:103` uses `ctx.env("LLAMA_API_KEY")` — a method on `AuthContext` from the external `@earendil-works/pi-ai` package, not a raw `process.env` read, hence the regex miss.

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| llama/client.ts:283,328 `unlink()` | **False positive.** `unlink` here is the return value of the local `linkSignal()` helper (an "un-link the abort listener" callback), not `fs.unlink`. No filesystem write occurs in this file. | — | — | — |

### trust

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| runner.ts:203-233 `emitProjectTrustEvent` | Lets an extension implement a custom "is this project trusted?" decision (`yes`/`no`/`undecided`, first non-`undecided` wins) | Bootstrap pass of `resource-loader.reload()`, before project-local extensions are added to the set | By construction, this runs *only* against user/global/CLI extensions — `resource-loader.loadProjectTrustExtensions()` forces `projectTrusted=false` first, so a malicious project-local extension cannot vote on its own project's trust | No (project-local content is explicitly excluded from voting) |
| types.ts:331-332 `ExtensionContext.isProjectTrusted()` | Read-only accessor extensions can query | Any handler/tool | — | No |
| types.ts:526-535 `ProjectTrustEventResult`/`ProjectTrustContext` | Type declarations for the above | — | — | — |
| runner.ts:86, types.ts:135-136 `confirm()` (`ExtensionUIContext.confirm`) | Generic yes/no dialog primitive extensions can show the user for *their own* purposes (e.g. "Unload model?") | Extension-initiated | This is a UI primitive, not a security confirmation gate enforced by the harness | N/A |
| llama/index.ts:129, llama/ui.ts:80,258,353,374,381,407,528 `confirm(...)`, `tui.select.confirm` keybinding | Same generic confirm dialog, used by the bundled llama extension (e.g. "Unload model?") and its keybinding hint text | `/llama` UI | — | N/A |

Dismissed from the "trust" bucket as unrelated to project/security trust (regex matched the word "confirm" only): runner.ts:86 (`"tui.select.confirm"` keybinding id string), runner.ts:237 (`noOpUIContext.confirm: async () => false` — a stub for headless modes), and all of `llama/ui.ts`'s `confirm`/`tui.select.confirm` occurrences — these are ordinary "press enter to confirm a UI selection" dialogs, not project-trust or extension-approval gates.

## Dismissed sweep hits (with reason)

- `llama/client.ts:283`, `llama/client.ts:328` (`fs-write`, `unlink()`) — local variable is an unsubscribe callback from `linkSignal()`, unrelated to `node:fs`. No file is ever written or deleted in `llama/client.ts`.
- `runner.ts:544` and `loader.ts:210` (`process-exec`, matched on "fork") — both are the literal text of a "stale extension context" error message that happens to mention `ctx.fork()` (session-tree fork), not `child_process.fork`.
- `types.ts:368` (`process-exec`, `fork(`) — `ExtensionCommandContext.fork(entryId, options)` is session-tree forking (branch the conversation), not a process API.
- `runner.ts:86` (`trust`, `"tui.select.confirm"`) — a keybinding id string constant, not a trust decision.
- `runner.ts:237` (`trust`, `confirm: async () => false`) — the no-op/headless UI context stub used in non-interactive modes (e.g. `print`), returns `false` for every dialog by construction; not a trust gate.
- `llama/ui.ts:80,258,353,374,381,407,528` (`trust`, various `confirm`) — ordinary TUI "confirm your selection" dialogs for the `/llama` overlay (e.g. confirming a key press or "Unload model?"), unrelated to project/extension trust.
- `types.ts:26,1444,1456,1473-1478` (`credentials`, mostly doc comments / type re-exports) — these are legitimate credential-related type declarations (see the credentials table above); not false positives, but mostly type-only surface with no executable sink in this file — the sink lives in `core/resolve-config-value.ts` and `core/provider-composer.ts` (out of scope).

## Capabilities found by reading, missed by the sweep

- **`ProviderConfig.apiKey`/`headers` → shell command execution.** `types.ts` documents `apiKey` as "API key literal, env interpolation, or leading `!command`". Reading `core/resolve-config-value.ts` (outside this scope but the direct consumer of this type) confirms that a value starting with `!` is executed via `execSync`/`spawnSync` with a real shell, cached for the process lifetime. The sweep tagged the doc comment as `credentials`, not `process-exec`, so this indirection would be missed by anyone filtering on the `process-exec` class alone.
- **Tool-call/tool-result mutation is unmediated and pre-approval.** `types.ts:898-902` documents that `event.input` in a `tool_call` handler is mutable "in place" and that "no re-validation is performed after mutation." Tracing the call site (`agent-session.ts:_installAgentToolHooks` → `packages/agent/src/agent-loop.ts:prepareToolCall`) shows `beforeToolCall` (i.e. the extensions' `tool_call` event) runs *after* schema validation but *before* the tool's own `execute()` — so any per-tool approval/confirmation UI (e.g. the bash tool's own permission prompt, implemented outside this scope) sees the extension-mutated arguments, not the model's original ones. A loaded extension therefore has a clean, silent point to rewrite what every tool call actually does, and this is invisible to the sweep because it's a data-flow property, not a matched keyword.
- **Extension-registered tools have no generic execution gate.** `ToolDefinition.execute()` (`types.ts:479-486`) is an arbitrary async function with full Node/Bun privileges, wired straight into the agent's tool loop (`wrapper.ts`) with no confirmation step comparable to the built-in bash tool's permission prompt — `core/tools/tool-definition-wrapper.ts` contains no approval logic. Any extension can therefore hand the model unmediated, unconfirmed execution power simply by calling `pi.registerTool()`.
- **Trust enforcement lives entirely outside this directory.** `discoverAndLoadExtensions()` (`loader.ts:689-737`), the function this scope exports as the "discover + load" entry point, performs no project-trust check itself — it happily loads `.pi/extensions/*` from any `cwd` it's given. The real CLI (`main.ts`) never calls it as the "final" loader; instead `resource-loader.ts` + `package-manager.ts` (both out of scope) gate project-local extension paths behind `SettingsManager.isProjectTrusted()` (default `true` unless a `resolveProjectTrust` callback says otherwise) before ever reaching `loadExtensionsCached`. Any embedder of the `@earendil-works/pi-coding-agent` SDK who calls the exported `discoverAndLoadExtensions`/`loadExtensions` directly (as the test suite does) gets **no** trust gate at all — this is a latent variant of CVE-2026-54325's class of bug at the SDK-surface level, mitigated in-product only because the shipped CLI doesn't use this entry point for the trust-sensitive path.
- **`registerProvider` as an LLM-traffic proxy/MITM primitive.** Not a bug, but a capability the sweep can't see: overriding an existing provider's `baseUrl` (documented example in `types.ts:1392-1395`) lets any loaded extension transparently redirect all traffic for e.g. `anthropic` to an attacker-controlled endpoint, with the harness never behaving differently. Combined with `emitBeforeProviderHeaders`, a compromised extension has first-class access to the live, resolved API key on every request (T4).
- **Symlink-following in discovery.** `discoverExtensionsInDir` (`loader.ts:652-684`) explicitly treats `entry.isSymbolicLink()` the same as a real file/directory for both the "direct file" and "subdirectory" branches, so a symlink placed inside a discovered extensions directory is followed and its target loaded/executed. Low severity (an attacker who can write into that directory can already write a `.ts` file directly) but worth a reviewer's eye for shared-machine (T3) scenarios where the *directory* is writable by an attacker but arbitrary file *creation* is otherwise restricted (e.g. quota, AppArmor path rules) while symlink creation is not.
- **`builtInExtensions` (llama.cpp) loads unconditionally.** `main.ts:530` always prepends `builtInExtensions` (currently just llama.cpp) to the extension factory list regardless of settings/flags; it is "hidden" from the UI list but not disableable via `noExtensions` in the same way user extensions are (confirm in `main.ts` if precise opt-out semantics matter to the reviewer).

## Questions for the human reviewer

1. Is it intended that `discoverAndLoadExtensions()`/`loadExtensions()` — the public SDK exports of this scope — carry no project-trust check at all, relying entirely on callers (the CLI's `resource-loader.ts`) to gate project-local paths? If any other embedder or future code path calls these directly against an untrusted `cwd`, it silently regains CVE-2026-54325-class behavior. Worth an explicit doc-comment warning or a defensive trust parameter.
2. Please confirm (in the `packages/agent` / tool-approval section of the audit) whether any built-in tool's user-facing permission/approval prompt is computed from arguments *before* or *after* the `tool_call` extension hook runs. My reading of `agent-loop.ts:prepareToolCall` says "after" (i.e., approval reflects mutated args, so no silent bait-and-switch of an already-approved command), but this crosses into the `packages/agent` package and deserves confirmation from whoever owns that section.
3. Is `ProviderConfig.apiKey`'s `!command` shell-execution syntax intended to be reachable from any value an extension might construct dynamically (e.g. from model output, tool results, or repo content), or is it documented/expected to only ever be a static string the extension author wrote? If the former, this is a process-exec sink worth its own dedicated review in the `resolve-config-value.ts`/`provider-composer.ts` area.
4. Does `noExtensions`/any CLI flag actually prevent `builtInExtensions` (llama.cpp) from loading, or only from being *listed*? The `hidden: true` flag in `src/extensions/index.ts` only affects UI visibility per its own doc comment.
5. Should `discoverExtensionsInDir` skip symlinks (or resolve+validate their targets stay within the extensions directory) to reduce the shared-machine (T3) attack surface described above?
