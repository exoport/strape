# Interactive TUI mode (core)

## Scope (files + LOC)

| file | LOC |
|---|---|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 6364 |
| `packages/coding-agent/src/modes/interactive/external-editor.ts` | 45 |
| `packages/coding-agent/src/modes/interactive/model-search.ts` | 21 |
| **total** | **6430** |

`model-search.ts` is a pure string-formatting helper (search-index text for the `/model` selector) with zero
capability sites — it appears in this report only for completeness. `interactive-mode.ts` is the `InteractiveMode`
class: the whole TUI event loop, slash-command dispatcher, key-handler table, and extension UI-context provider.
`external-editor.ts` is the `Ctrl+G` "open in $EDITOR" helper. Sub-components under `components/` and `theme/`
(not top-level `.ts` files) are out of scope for this section and are covered elsewhere in the capability map.

## What this area can do (prose, 1 para)

`InteractiveMode` is the orchestration layer a human directly drives: it owns the render loop, the slash-command
table (`/login`, `/logout`, `/trust`, `/export`, `/import`, `/share`, `/reload`, `/quit`, …), the `!command` /
`!!command` shell-escape, the `Ctrl+G` external-editor handoff, and the `ExtensionUIContext` that every loaded
extension/skill uses to draw dialogs, set the footer/header, or inject text into the editor. On its own it does
almost no I/O — it is a thin dispatcher that delegates process execution, credential storage, network calls and
session (de)serialization to collaborators (`session.modelRuntime`, `session.executeBash`, `runtimeHost`,
`DefaultPackageManager`, `ProjectTrustStore`) that live in `core/*` and are reviewed in other sections. Its own
direct capabilities are: spawning three specific external binaries (`tmux`, `gh` ×2) with fixed argument lists,
writing a handful of files under `os.tmpdir()`/`getAgentDir()` (clipboard-paste images, a debug log, a `/share`
staging HTML file), two outbound `fetch`/hyperlink references (install telemetry, a static changelog URL), and
reading/displaying (never itself persisting) provider credentials and project-trust state. The most consequential
finding is not a missing check inside this file but a temp-file naming choice: the `/share` command's staging
file is a **fixed, non-random path** (`os.tmpdir()/session.html`), unlike the correctly-randomized
`mkdtempSync`-based editor scratch dir in `external-editor.ts`.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:1108` | `spawn("tmux", ["show","-gv", option], …)` to read tmux's `extended-keys`/`extended-keys-format` options | startup, only `if (process.env.TMUX)` | fixed argv, no shell, 2s timeout, output only used to print an advisory string | No — argv is hardcoded; env var only gates whether it runs |
| `interactive-mode.ts:5827` | `spawnSync("gh", ["auth","status"], …)` — checks GitHub CLI login state | user runs `/share` | fixed argv, no shell | No |
| `interactive-mode.ts:5876` | `spawn("gh", ["gist","create","--public=false", tmpFile])` — uploads the exported session HTML as a secret gist | user runs `/share`, after the `gh auth status` check passes | fixed argv except `tmpFile` (see temp-paths below); no shell; user must already have `gh` installed and authenticated | Path argument is a program-controlled constant, not attacker data, but see temp-paths finding — the *contents* read from that path at upload time are attacker-racable |
| `external-editor.ts:25` | `spawn(editor, [...editorArgs, filePath], { stdio: "inherit", shell: win32 })` — launches the user's external editor on a scratch file | user presses `Ctrl+G` (`app.editor.external`) | `editor`/`editorArgs` come from `settings.externalEditor` (global or **project** `.pi/settings.json`) or `$VISUAL`/`$EDITOR`; `filePath` is a `mkdtempSync`-generated path, not attacker text | Command string itself can be attacker-influenced if a malicious/untrusted project's `.pi/settings.json` sets `externalEditor` — see "Questions for human reviewer" |
| `interactive-mode.ts:6248-6330` (`handleBashCommand` → `session.executeBash`) | Executes an arbitrary shell command the user typed after `!`/`!!` | user types `!<cmd>` or `!!<cmd>` and presses Enter | Purely user-typed literal text (`text.startsWith("!")` in the literal `onSubmit` handler); an extension can intercept via `emitUserBash` before execution but cannot inject a bash invocation that the user didn't type in this file | The command text is 100% user-authored in this code path; the *actual* subprocess creation is in `session.executeBash` (out of this file's scope) |

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:1190` | `fetch("https://pi.dev/api/report-install?version=...")` — install/changelog telemetry ping, version number only | startup, on fresh install or when a new changelog entry is shown | `if (process.env.PI_OFFLINE) return;` and `isInstallTelemetryEnabled(settingsManager)` gate; 5s abort signal; response ignored | No — only the local package version string is sent, not derived from repo/model content |
| `interactive-mode.ts:995-1002` | `this.session.modelRuntime.refresh(...)` at startup — refreshes provider/model availability (implementation, and any outbound calls, live in `core/model-runtime.ts`) | startup | `if (!process.env.PI_OFFLINE)`; 15s abort | No — not literally a `fetch(` in this file, flagged under "missed by sweep" below |
| `interactive-mode.ts:1006`, `1013` | `checkForNewPiVersion()` / `checkForPackageUpdates()` — calls into `utils/version-check.ts` and `core/package-manager.ts` which perform the actual registry/network requests | startup | implementation-level gating lives in the callees (out of scope file) | No |
| `interactive-mode.ts:223`, `4079`, `5833` | Static URL strings shown to the user (`claude.ai/settings/usage` warning text, `pi.dev/changelog` hyperlink, `cli.github.com` install hint) | display only | n/a | **Dismissed** — no code path fetches these; see below |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:2814-2822` | Writes clipboard-image bytes to `os.tmpdir()/pi-clipboard-<crypto.randomUUID()>.<ext>` | user presses `Ctrl+V` and clipboard holds an image | filename uses `crypto.randomUUID()` — not predictable/guessable | No — image bytes come from the OS clipboard, not repo content, though a malicious repo could have put something on the clipboard earlier via an already-approved tool |
| `interactive-mode.ts:6214-6215` | `/debug`-triggered dump: full rendered TUI lines **and every session message (JSONL)** written to `getDebugLogPath()` (`~/.pi/agent/pi-debug.log`, predictable, fixed name, no explicit `mode`) | user-bound debug keystroke (`ui.onDebug`) | none beyond default `fs.writeFileSync` (umask-derived permissions); path is fixed and previously-written contents are silently overwritten | Content can include anything that ended up in the session transcript (pasted secrets, tool output, attacker-authored file content echoed by the model) — see T4 note below |
| `interactive-mode.ts:5838-5859` | `/share`: exports full session to HTML at **`path.join(os.tmpdir(), "session.html")`** (fixed name, no randomness), then `fs.unlinkSync(tmpFile)` in a `finally`-style cleanup | user runs `/share` | none — no `mkdtempSync`, no exclusive-create flag, no permission hardening; write itself happens inside `session.exportToHtml` → `core/export-html/index.ts` via plain `writeFileSync(outputPath, html, "utf8")` (default mode, world-readable minus umask on typical Linux) | **Yes, by a local co-resident user** — see finding below |
| `external-editor.ts:14-17,40` | Writes prompt-editor draft text to `mkdtempSync(tmpdir(), "pi-editor-")/prompt.md`, removes the whole dir in `finally` | `Ctrl+G` | random `mkdtemp` prefix — standard-safe pattern | No |

### temp-paths

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:5838` | `const tmpFile = path.join(os.tmpdir(), "session.html")` — **static, predictable filename in the shared system temp directory** | `/share` | none | **This is the standout finding of this section** — see below |
| `interactive-mode.ts:2818` | `os.tmpdir()` combined with a `crypto.randomUUID()` filename for clipboard images | `Ctrl+V` | randomized suffix | Safe pattern, contrast with the line above |
| `external-editor.ts:14` | `mkdtempSync(join(tmpdir(), "pi-editor-"))` | `Ctrl+G` | atomic, random, exclusive directory creation — the correct pattern | Safe |

**Finding — predictable `/share` temp path (sibling of CVE-2026-54328 class, but a disclosure/integrity bug rather than the original's privesc):**
`handleShareCommand` (`interactive-mode.ts:5824-5900`) builds `os.tmpdir()/session.html`, a name any local user
on a shared machine can predict, then calls `session.exportToHtml(tmpFile)` which does a plain
`writeFileSync(outputPath, html, "utf8")` with no `wx`/exclusive flag and no explicit file mode (`core/export-html/index.ts`,
outside this file but the vulnerable call site — the unguarded static path — is in scope here). Consequences on a
multi-user host (T3):
1. **Disclosure window**: between the write and the `fs.unlinkSync(tmpFile)` cleanup (which only runs after the
   `gh gist create` subprocess exits — this can be seconds, longer over a slow network, or indefinitely if the
   process is killed before cleanup), the file sits at a guessable path with default (typically world-readable)
   permissions. Any other local user can read the victim's full conversation transcript, including anything the
   model or tool output echoed (source snippets, secrets pasted into chat, etc.) — a T4 exfiltration vector that
   requires no exploit beyond `cat /tmp/session.html` at the right moment, or simply polling.
2. **Symlink / TOCTOU**: an attacker who pre-creates `/tmp/session.html` as a symlink to a file the *victim* can
   write (their own dotfiles, another world-writable app's config, etc.) before the victim runs `/share` can turn
   this into an attacker-directed overwrite of a victim-owned file (classic `/tmp` race). Because there is no
   `O_EXCL`/`wx` open and no pre-unlink-then-recreate check, `writeFileSync` follows the symlink.
3. Two concurrent `/share` invocations (same or different users) collide on the identical path.
This is a direct sibling of the temp-path CVE class the harness already fixed once (CVE-2026-54328) — the fix
pattern is right there in the same directory (`external-editor.ts`'s `mkdtempSync`) but was not applied to
`/share`'s export path.

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:225-227` | `isAnthropicSubscriptionAuthKey()` — string-prefix check (`sk-ant-oat`) on an API key already resolved by `modelRuntime.getAuth` | model-switch / login completion | read-only check, key never written to disk or logged here | No |
| `interactive-mode.ts:4641-4646` | Reads the resolved API key for the active model purely to decide whether to show the Anthropic-subscription-billing warning | after `/login`, model switch, or startup | key is compared, never displayed/logged | No |
| `interactive-mode.ts:5133-5174` | Builds the `/login` and `/logout` provider option lists from `modelRuntime.getProviders()`/`getProviderAuthStatus()`/`listCredentials()` | user runs `/login`/`/logout` | display metadata only (provider id/name/auth type/source label) — no raw secret material passes through this file | No — provider list is static config (`models.json`), not attacker-influenced repo content |
| `interactive-mode.ts:5212-5638` (`startProviderLogin`, `showLoginDialog`, `showApiKeyLoginDialog`, `loginProvider`, `showOAuthSelector` logout path) | Entire `/login`/`/logout` UI flow; actual OAuth exchange, API-key persistence, and `auth.json` read/write happen inside `session.modelRuntime.login/logout` (`core/model-runtime.ts`, out of this file's scope) | user runs `/login <provider>` / `/logout` | UI-level only: confirmation dialogs, `AbortSignal.timeout(15_000)` on network-bound credential calls | No — this file is a pure dispatcher; the auth.json write-race surface (CVE-2026-54327 class) lives in `model-runtime.ts`, reviewed elsewhere |
| `interactive-mode.ts:5421,5425` | Status messages: `Credentials saved to ${getAuthPath()}` | after successful login | display only | No |
| `interactive-mode.ts:1037-1039` | Displays `Migrated credentials to auth.json: ...` warning | startup, when `options.migratedProviders` is non-empty (migration itself performed upstream of this file) | display only | No |

### trust

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:3679-3697` | Renders "This project is not trusted..." banner when `!settingsManager.isProjectTrusted() && hasTrustRequiringProjectResources(cwd)` | startup / after `/reload`, when cwd has `.pi` resources | display only; the actual enforcement (ignoring `.pi` extensions/skills/prompts for untrusted cwd) happens in the resource loader (out of scope) | Repo content (presence of a `.pi` dir with resources) determines whether the banner shows, but the banner itself grants nothing |
| `interactive-mode.ts:4678-4699` (`showTrustSelector`) | `/trust` command: reads/writes `ProjectTrustStore` entries via explicit user selection (`TrustSelectorComponent`) | user runs `/trust` and picks an option | requires explicit user selection in a modal; takes effect only after restart (message says so) | No — decision is 100% user-driven |
| `interactive-mode.ts:4652-4676` (`maybeSaveImplicitProjectTrustAfterReload`) | **Auto-saves** `trustStore.set(cwd, true)` — no user confirmation dialog — when: (a) the session's cwd matches `autoTrustOnReloadCwd` (set when the session started with *no* `.pi` dir, i.e. implicitly trusted), (b) `settingsManager.isProjectTrusted()` is now true, and (c) the cwd has since gained trust-requiring resources | `/reload` | Only fires if `trustStore.get(cwd) === null` (no prior explicit decision); guarded by the "started implicitly trusted" flag set at session construction (outside this file) | **See "Questions for human reviewer"** — if a `.pi/extensions` or `.pi/skills` directory can be created *during* an implicitly-trusted session (e.g. by an agent tool call the user approved for an unrelated reason, or by prompt-injected instructions telling the model to `mkdir .pi/skills`), a subsequent `/reload` persists trust for that cwd with no explicit "do you trust this new resource" prompt |
| `interactive-mode.ts:2440-2447` (`showExtensionConfirm`) + `2327-2379` (`createExtensionUIContext`) | The full `ExtensionUIContext` surface (`confirm`, `select`, `input`, `pasteToEditor`, `setEditorText`, `custom` component factory, `setFooter`/`setHeader`, `onTerminalInput`) handed to already-loaded extensions/skills | any extension/skill callback | Extension code is by this point already running in-process with full JS privileges (approval happens at load time, in the extension loader — reviewed elsewhere); these are just UI callbacks, not a privilege boundary | Not a new privilege grant given an already-approved extension, but `pasteToEditor`/`setEditorText` let an extension pre-fill the prompt box with arbitrary text a user might reflexively hit Enter on — see notes below |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `interactive-mode.ts:995,1086,1182` | Three `process.env.PI_OFFLINE` checks gating model-refresh, package-update-check, and install-telemetry network calls | startup | Env var is operator/launcher-controlled (strape's launcher sets an offline posture per `strape/bin/strape`) | No — not attacker-influenceable via repo content |
| `interactive-mode.ts:1104` | `process.env.TMUX` gates whether `tmux show -gv ...` is spawned | startup | n/a | No |

## Dismissed sweep hits (with reason)

- `interactive-mode.ts:223` (network) — `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` is a static string literal containing a URL (`claude.ai/settings/usage`) shown as advisory text; no `fetch`/request is made. **False positive.**
- `interactive-mode.ts:4079` (network) — `changelogUrl` is a constant used only to build a terminal hyperlink/text label (`hyperlink(...)`); nothing is fetched. **False positive.**
- `interactive-mode.ts:5833` (network) — string literal in an error message pointing the user to `cli.github.com`; not a network call. **False positive.**
- `interactive-mode.ts:1820`, `4874`, `4904` (process-exec, `runtimeHost.fork(...)`) — `fork` here is `AgentSessionRuntime.fork()` (`core/agent-session-runtime.ts:262`), a **conversation-tree branch/fork operation** (creates a new session state at a given message entry), not `child_process.fork`. Confirmed by reading the callee. **False positive**, but a plausible one given the naming collision with Node's `child_process.fork`.
- `interactive-mode.ts:47` (process-exec, `import { spawn, spawnSync } from "child_process"`) — this is the import statement enabling the three real call sites (tmux, gh×2) already listed in the inventory above; not a distinct capability site itself. **Not dismissed as irrelevant, just not double-counted.**
- `interactive-mode.ts:90`, `100`, `151` (credentials/trust imports: `CredentialSynchronizationError`, `hasTrustRequiringProjectResources`/`ProjectTrustStore`, `TrustSelectorComponent`) — plain import statements; the actual usages are covered under their respective call sites above. **Not distinct capability sites.**
- `interactive-mode.ts:316` (credentials) — a doc comment (`/** Providers that were migrated to auth.json (shows warning) */`) with no executable code. **False positive.**
- `interactive-mode.ts:320` (trust) — a doc comment describing the `autoTrustOnReloadCwd` field; the real capability is the code at `4652-4676`, already covered. **Not a distinct site.**
- `interactive-mode.ts:5722` (trust) — a status string (`"Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"`) that merely reports what `/reload` did; the actual trust-saving logic is `maybeSaveImplicitProjectTrustAfterReload`, already covered. **Not distinct.**
- `interactive-mode.ts:5492` (credentials) — advisory text ("You can also use an AWS profile, IAM keys, or role-based credentials.") shown in the Bedrock login dialog; no credential material is handled by this line. **False positive.**

## Capabilities found by reading, missed by the sweep

1. **`!`/`!!` shell execution (`interactive-mode.ts:2975-2989`, `6248-6330`)** — the sweep's `process-exec` regex only matches literal `spawn(`/`exec(`-style tokens, so it did not flag the bash-mode feature at all, even though it is this file's most direct "run an arbitrary command" capability. It is, however, purely user-typed (the `text.startsWith("!")` check runs on the literal editor-submitted string), and an extension can only intercept via `emitUserBash`, not fabricate a command the user didn't type. The subprocess itself is created in `session.executeBash` (`core/agent-session.ts`, different area).
2. **Clipboard paste can transitively spawn OS utilities** (`interactive-mode.ts:2814-2822` → `utils/clipboard-image.ts`) — `readClipboardImage()` shells out to `wl-paste`, PowerShell, or `xclip` depending on platform (`clipboard-image.ts:118,161,213`). None of this is visible from `interactive-mode.ts` text alone (no `spawn(` token in this file), so the sweep missed it entirely for this area. Arguments are hardcoded, not attacker-controlled, so this is low-risk but is a real, sweep-invisible process-exec capability reachable from a single keystroke (`Ctrl+V`).
3. **Startup network calls with no literal `fetch(` in this file** (`interactive-mode.ts:995-1002` `modelRuntime.refresh()`, `1006` `checkForNewPiVersion()`, `1013` `checkForPackageUpdates()`) — all three make outbound network requests via callees in `core/model-runtime.ts`, `utils/version-check.ts`, and `core/package-manager.ts` respectively. The sweep only caught the one literal `fetch(...)` at line 1190 (install telemetry); the other three network-triggering call sites in this file were missed because the request itself is one hop away.
4. **`externalEditor` setting is attacker-reachable via project settings** — `SettingsManager.getExternalEditorCommand()` (`core/settings-manager.ts:859-867`) prefers `this.settings.externalEditor`, which is `deepMergeSettings(globalSettings, projectSettings)` where `projectSettings` is loaded from `<cwd>/.pi/settings.json` (`settings-manager.ts:201`). Nothing in `settings-manager.ts` itself gates this load on project trust. If project-settings loading is not trust-gated elsewhere in the pipeline (a question for whoever reviewed `core/settings-manager.ts` / the resource loader), an untrusted repo's `.pi/settings.json` could set `externalEditor` to an arbitrary command that runs the next time the victim presses `Ctrl+G` — a plain `spawn` with `shell: true` on Windows. This spans two files outside pure "interactive-mode.ts", but the vulnerable *sink* (`external-editor.ts:25`) and the *trigger* (`interactive-mode.ts:4037-4053`) are both in this area's scope.

## Questions for the human reviewer

1. **`/share`'s predictable temp path (`interactive-mode.ts:5838`)** — confirm whether this should be treated as a genuine regression/sibling of CVE-2026-54328. Recommended fix mirrors the pattern already used two files away: `mkdtempSync(join(tmpdir(), "pi-share-"))` plus an exclusive-create write, unlinking the whole directory afterward.
2. **Debug-log write (`interactive-mode.ts:6191-6222`)** — dumps the entire session JSONL (which can contain secrets echoed into chat/tool output) to a fixed, predictable path (`~/.pi/agent/pi-debug.log`) with default file permissions. Is `getAgentDir()` created with a restrictive mode (0700) anywhere in `config.ts`/startup code? If not, this is a T3/T4 local-disclosure vector on shared machines, parallel to the `/share` finding but lower severity (single-user home dir vs. shared `/tmp`).
3. **Implicit-trust auto-save on `/reload` (`interactive-mode.ts:4652-4676`)** — does any code path allow a `.pi/extensions` or `.pi/skills` directory to be created *during* an interactive session (e.g., by a tool call, or by the agent following prompt-injected instructions) before the user runs `/reload`? If so, this auto-save path grants trust to newly-appeared project resources without an explicit "new resource, do you trust it?" prompt — worth confirming against whatever gate exists in the resource loader / trust-manager area.
4. **`externalEditor` project-setting reachability** — is `.pi/settings.json` loading itself gated on `ProjectTrustStore`/`isProjectTrusted()` somewhere in `core/settings-manager.ts` or its caller, before `SettingsManager` is constructed for a session? This determines whether item 4 above ("Capabilities found by reading") is exploitable by an untrusted repo or is a non-issue because untrusted-project settings are never loaded at all. This file (`interactive-mode.ts`) does not perform that gating itself, so the answer must come from whoever reviewed `core/settings-manager.ts` or the session-bootstrap path.
5. **`ExtensionUIContext.pasteToEditor`/`setEditorText`** (`interactive-mode.ts:2349-2350`) — confirm this is intentionally scoped to already-approved, in-process extension code (it is not reachable from raw repo content or model tool calls per this file), and that no extension can also programmatically trigger `onSubmit` (auto-send) rather than merely pre-filling text a human must still press Enter on.
