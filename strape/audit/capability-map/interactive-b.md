# Interactive TUI components

## Scope (files + LOC)

`packages/coding-agent/src/modes/interactive/components/` — 42 files, 9446 LOC total, no subdirectories.

| file | LOC | role |
|---|---|---|
| `config-selector.ts` | 942 | `/config` resource manager UI — enable/disable extensions/skills/prompts/themes, **writes settings.json** |
| `tree-selector.ts` | 1427 | `/tree` conversation-branch navigator, tree rendering, label edit UI |
| `session-selector.ts` | 1031 | `/resume` session picker — list/search/rename/**delete session files** |
| `settings-selector.ts` | ~950 | `/settings` menu, incl. "Default project trust" (ask/always/never) toggle |
| `tool-execution.ts` | 377 | renders a tool call + its result in the transcript |
| `bash-execution.ts` | 220 | renders streaming `bash` tool output (ANSI-stripped) |
| `login-dialog.ts` | 233 | OAuth/device-code/API-key login flow UI, opens browser, renders provider URLs |
| `oauth-selector.ts` | 214 | provider picker for `/login`/`/logout` |
| `extension-editor.ts` | 133 | multi-line text editor for extension-driven prompts; `Ctrl+G` opens `$VISUAL`/`$EDITOR` |
| `extension-input.ts` / `extension-selector.ts` | 87 / 112 | generic text-input / list-select primitives an extension can pop up |
| `custom-message.ts` / `custom-entry.ts` | 113 / 62 | render an extension-supplied `Component` directly into the transcript |
| `first-time-setup.ts` | 145 | onboarding wizard (theme pick, etc.) |
| `trust-selector.ts` | 135 | "Project trust" prompt UI (reads `core/trust-manager.ts`) |
| `mermaid.ts` | 90 | renders ` ```mermaid ` blocks from model text as local ASCII art (no network/exec) |
| `markdown-transform.ts` | 29 | pipes rendered markdown through extension-registered `MarkdownTransformer[]` (display-only) |
| `assistant-message.ts` / `user-message.ts` / `custom-editor.ts` / `diff.ts` / others | remainder | message/diff/loader/border rendering, selectors for model/theme/thinking/scoped-models/show-images, keybinding-hint formatting |

All 42 files are pure TypeScript UI components built on `@earendil-works/pi-tui` (`Container`/`Text`/`Input`/`Editor`/`Markdown`). None of them define a slash command or own the event loop — that lives in `interactive-mode.ts`, covered by `interactive-a.md`. `external-editor.ts` (the `$EDITOR` spawn helper reused by `extension-editor.ts`) is also outside this directory and already covered by `interactive-a.md`; it is only cited here for context. `git diff v0.84.0..main --stat` touches nothing in this directory — everything here is unmodified upstream v0.84.0 code.

## What this area can do (prose, 1 para)

This directory is almost entirely *rendering and input-handling* — components turn session/tool-call state into terminal text and turn keystrokes into callbacks owned by `interactive-mode.ts` — so on its own it has very little independent capability. The two real capability sites are `session-selector.ts`, which runs `spawnSync("trash", [sessionPath])` and falls back to `unlink(sessionPath)` when the user presses a delete-confirm key on a session file, and `config-selector.ts`, which is the human-approval UI for the extension/skill/prompt/theme allowlist: every checkbox toggle here calls into `SettingsManager` setters that synchronously `writeFileSync` the project or global `settings.json` (an fs-write indirection the regex sweep missed entirely, since no `fs`/`write` call appears literally in this file). Three components extend the trust surface in a less obvious way: `markdown-transform.ts` lets any *already-loaded* extension rewrite the Markdown of every assistant/user message before it hits the screen (display-only — it does not touch the persisted transcript or what is re-sent to the model), and `custom-message.ts`/`custom-entry.ts` let an already-loaded extension hand back an arbitrary `Component` instance that this code mounts and renders directly, i.e. once an extension is trusted it can fully control what appears in the transcript. `login-dialog.ts` opens the OS browser (`openBrowser`, argv-based `spawn`, no shell) for OAuth URLs and builds raw OSC-8 hyperlink escape sequences around those URLs; `extension-editor.ts` shells out to `$VISUAL`/`$EDITOR` (via the out-of-scope `external-editor.ts` helper) only when the user explicitly presses the "open external editor" key. Nothing in this directory itself decides whether an extension gets to run, whether a project is trusted, or whether a tool call is allowed — it only renders those decisions (`trust-selector.ts`, the "Default project trust" setting in `settings-selector.ts`) and forwards user keystrokes to callbacks the caller supplies.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `session-selector.ts:650` | `spawnSync("trash", trashArgs, { encoding: "utf-8" })` — moves a session file to the OS trash; `trashArgs` is `["--", sessionPath]` when the path starts with `-` (flag-injection guard), else `[sessionPath]` | User selects a session and presses the delete key twice (confirm) in `/resume` | Requires two keypresses (`app.session.delete` then `tui.select.confirm`) and cannot target the currently-active session (`isCurrentSessionPath` check in `session-list.startDeleteConfirmationForSelectedSession`) | Low. `sessionPath` comes from enumerating the local sessions directory, not from model/repo content; a local attacker who can drop files into that directory (T3) controls the argv value, but it's passed as a literal argv element (not through a shell), so at worst it's an odd/garbage path to `trash`, not command injection |
| `session-selector.ts:1` (`import { spawnSync } from "node:child_process"`) | import only | n/a | n/a | Sweep artifact — the real site is line 650 above |
| `extension-editor.ts` → `external-editor.ts:25` (out of this dir, invoked from here) | `spawn(editor, [...editorArgs, filePath], { stdio: "inherit", shell: win32 only })` launches `$VISUAL`/`$EDITOR` | User presses `app.editor.external` while editing extension-provided text | argv array, no shell on non-Windows; `editor`/`editorArgs` come from splitting the env var or a caller override on spaces (functionality bug for editors with spaces in their path, not a security control) | `$VISUAL`/`$EDITOR` is local shell config (T3 territory only); the *content* being edited can be extension/model-supplied but is just written to a temp file, not interpreted |
| `login-dialog.ts:111` → `utils/open-browser.ts` (out of this dir) | `spawn("open"/"xdg-open"/"rundll32", [url], { shell:false })` launches the OS browser on the OAuth URL | Automatically when `showAuth(url)` is called during a `/login` flow the user started | argv-array launch, explicit comment noting `cmd /c start` was avoided specifically to prevent metacharacter injection on Windows | `url` originates from the OAuth provider response for a login the user initiated, not from repo/model content; low, but see the OSC-8 escape note below for a related concern with the same string |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `session-selector.ts:672` | `await unlink(sessionPath)` — fallback permanent delete when `trash` is unavailable or fails | Same as the `trash` call above | Same two-keypress confirm + "not the active session" guard | Same as above — local session-file path, not model/repo controlled |
| `config-selector.ts` (`toggleTopLevelResource` / `togglePackageResource` / `setProjectTopLevelOverride` / `setProjectPackageOverride`, e.g. lines 532-637, 665-729) → `SettingsManager.set*Paths`/`setPackages`/`setProjectPackages` (`core/settings-manager.ts`, out of this dir) | Every toggle in the `/config` resource list synchronously rewrites `settings.json` (global `~/.pi/agent/settings.json` or project `.pi/settings.json`) with an updated allow/deny pattern for the toggled extension/skill/prompt/theme | User presses Space/Enter on a resource row in `/config` | The *only* guard is the keypress itself — no confirmation dialog, no diff/preview of what the resource file contains before enabling it; the displayed name is just `basename(path)` | Indirectly yes: the item list (`resolvedPaths.*`) is built from packages/extensions discovered on disk, which can include a malicious repo's checked-in `.pi/` package definitions (T1). The write itself only fires on a real user keypress, so this is the intended human-approval gate for CVE-2026-54325-style "extension loading" — but it offers no code preview, so a convincingly-named malicious extension can be opted into with a single keypress |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `extension-editor.ts:55-56` | `process.env.VISUAL \|\| process.env.EDITOR \|\| "nano"/"notepad"` picks the external-editor command | Constructor of `ExtensionEditorComponent` | None; trusts local environment | T3 only (local env config) |
| `footer.ts:114` | `process.env.HOME \|\| process.env.USERPROFILE` used only to shorten the displayed cwd (`~/...`) | Every footer render | Cosmetic only, no security role | No — display formatting, not a decision input |
| `tree-selector.ts:940` | Same `HOME`/`USERPROFILE` pattern, used to shorten displayed tool-call paths (`shortenPath`) in `/tree` | Rendering a `read`/`write`/etc. tool-call entry | Cosmetic only | No |

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| — | (see "Dismissed sweep hits") — no real network call exists in this directory's own code | | | |

## Dismissed sweep hits (with reason)

- **`trust` class, ~58 of 63 hits** (e.g. every `kb.matches(keyData, "tui.select.confirm")`, `keyHint("tui.select.confirm", ...)`, `confirmingDeletePath`, `confirmRename`, across `config-selector.ts`, `extension-editor.ts`, `extension-input.ts`, `extension-selector.ts`, `first-time-setup.ts`, `login-dialog.ts`, `model-selector.ts`, `oauth-selector.ts`, `scoped-models-selector.ts`, `tree-selector.ts`, `user-message-selector.ts`, most of `session-selector.ts`). The sweep's `trust` regex is `\bconfirm\b` (among others), which matches the generic TUI keybinding id `tui.select.confirm` (Enter-to-select) everywhere it appears. These are UI "confirm the currently highlighted item" hints with no relationship to the security concept of *project/extension trust*; the delete/rename confirmation flows in `session-selector.ts` are genuine "confirm a destructive action" gates (covered in the process-exec/fs-write tables above) but are not "trust" in the CVE sense either.
- **`trust` class, `index.ts:35`** (`export { TrustSelectorComponent } ...`) — a barrel re-export, not a capability site; the real logic is in `trust-selector.ts` (read in full, see below).
- **`network` class, `daxnuts.ts:148`** (`https://mistral.ai/news/mistral-vibe-2-0`) and **`earendil-announcement.ts:7`** (`BLOG_URL = "https://mariozechner.at/..."`) — both are string literals rendered as plain text/`mdLink`-styled labels inside a static easter-egg/announcement banner (verified full file for `earendil-announcement.ts`). Neither file makes an HTTP request; the URL is only ever written to the terminal for the human to click or copy. No `fetch`/`http`/`https` client call exists in either file.
- **`settings-selector.ts:50-51, 575-577, 825`** (`"Always trust"`/`"Never trust"` labels, `default-project-trust` setting id/description, switch case) — these *are* genuine trust-relevant lines (see inventory prose above: this is where a user can set the global default to "Always trust" and skip future per-project prompts), so they are not dismissed as false positives, just folded into the prose rather than a table row since they don't fit process-exec/fs-write/env/network shapes — the actual persistence call is a `SettingsManager` setter identical in kind to the `config-selector.ts` fs-write already tabled above.

## Capabilities found by reading, missed by the sweep

- **`config-selector.ts` settings writes** (see fs-write table): every `SettingsManager.set*` call in this file bottoms out in `writeFileSync` inside `core/settings-manager.ts:252` (confirmed by reading that file). None of these call sites contain the literal strings the sweep's `fs-write` regex looks for (`writeFile`, `fs.write`, etc.), so this entire "human approves an extension/skill/theme" write path was invisible to the deterministic sweep. This is the most important finding in this section given the CVE-2026-54325 ("extension loading without approval") history: the approval gate exists and is keypress-driven, but grants full trust on a single keypress with no content preview.
- **`markdown-transform.ts` extension hook**: `createMarkdownTransform` threads a list of extension-registered `MarkdownTransformer` functions into every `Markdown` component (`assistant-message.ts:112,157`, presumably `user-message.ts`/`tool-execution.ts` too). Confirmed by reading `assistant-message.ts` that transformers only affect the string handed to the `Markdown` renderer at draw time — `this.lastMessage` (the object other subsystems read/persist) is untouched — so this is a display-integrity capability (a malicious/compromised *already-loaded* extension could visually alter what the user reads) rather than a session/context-poisoning one.
- **`custom-message.ts` / `custom-entry.ts` arbitrary component mounting**: `this.customRenderer(...)`/`this.renderer(...)` (extension-supplied functions) return a `Component` that is added directly to the transcript's `Container` tree and subsequently rendered every frame. Not a privilege escalation beyond "extension code already runs in-process," but it means the transcript's visual truth is fully delegated to any loaded extension for `customType` messages/entries — worth knowing when reasoning about what a compromised extension can hide or fabricate in what the user sees.
- **Inconsistent ANSI/control-character handling across renderers**: `bash-execution.ts:83` explicitly calls `stripAnsi()` on live command output before display. No equivalent call exists in `tool-execution.ts`, `user-message.ts`, `custom-message.ts`, or `diff.ts` (grepped for `stripAnsi`/`ansi` imports — none found), even though these render `read`/`grep`/`write` tool arguments and results, and file diffs, whose content can come straight from repo files (T1). Whether this is an actual escape-injection gap depends on whether `pi-tui`'s `Text`/`Markdown` components themselves neutralize non-SGR control sequences before writing to the terminal — that lives in the `pi-tui` dependency, out of this directory's scope, so I could not confirm either way from source in this directory alone.
- **`login-dialog.ts` raw OSC-8 construction** (`showAuth`, `showDeviceCode`, `showInfo`, lines 99-104, 121-126, 194): builds terminal hyperlink escape sequences by string-interpolating the provider-supplied `url`/`link.url` directly into `\x1b]8;;${url}\x07...`, with no validation that the string is free of embedded escape/control characters. Exploitability requires a compromised or MITM'd OAuth provider response (the providers here are OpenAI/xAI per strape's provider-scope restriction), so likelihood is low, but there is no defensive stripping/validation at this layer either.

## Questions for the human reviewer

1. Does `pi-tui`'s `Text`/`Markdown` rendering path (dependency, not in this directory) strip or neutralize arbitrary ANSI/OSC control sequences from content it did not itself generate? If not, `tool-execution.ts`/`diff.ts`/`user-message.ts` render raw file/tool content to the real terminal with no sanitization layer in this directory, unlike `bash-execution.ts` which explicitly strips ANSI.
2. `config-selector.ts` is effectively *the* human-approval UI referenced by other sections for extension/skill/theme loading (CVE-2026-54325 lineage). Should enabling a resource here show any preview of its source/diff before the keypress commits it to `settings.json`, especially for project-scope resources that arrived via a cloned/untrusted repo?
3. `settings-selector.ts` exposes a global "Default project trust: Always trust" option that, if set, presumably removes the per-project trust prompt entirely for all future projects. Confirm with `core/trust-manager.ts` (out of this section's scope) exactly what "always" bypasses, since combined with T1 it would mean every future `cd`-and-launch into an arbitrary repo starts pre-trusted.
4. Is there a max-size/backpressure control on `tree-selector.ts`'s in-memory tree building (`buildSessionTree`/`flattenSessionTree`, recursive) for sessions with very large or maliciously deep parent-chains? Not exploited from this directory alone, but worth a cross-check with session-manager.
