# pi-tui

## Scope (files + LOC)

`packages/tui/src/` — 36 files, 15,887 LOC total. Notable by size: `components/editor.ts` (2,363),
`utils.ts` (1,326), `keys.ts` (1,401), `tui.ts` (1,256), `tui-alt-screen.ts` (890), `latex.ts` (1,225),
`components/markdown.ts` (1,010), `autocomplete.ts` (786), `terminal-image.ts` (657), `terminal.ts` (540),
`tui-main-screen.ts` (586), `stdin-buffer.ts` (434). This is the rendering/input layer of the harness: raw
terminal I/O (raw mode, Kitty keyboard protocol, mouse/SGR, bracketed paste), a layout/diff-render engine,
editor/autocomplete widgets, markdown+LaTeX rendering, and image protocol (Kitty/iTerm2) encode/decode. It has
no network client, no model/tool-call logic, and no direct credential handling — those live in
`packages/coding-agent` and the provider packages, which call into `pi-tui` only for display and to receive
parsed keystrokes.

## What this area can do (prose, 1 para)

`pi-tui` puts the real terminal into raw mode and bracketed-paste mode, negotiates the Kitty keyboard
protocol, and thereafter owns every byte written to stdout and interpreted from stdin (`terminal.ts`,
`stdin-buffer.ts`, `keys.ts`, `tui.ts`, `tui-main-screen.ts`, `tui-alt-screen.ts`). It renders arbitrary
string content — including content composed elsewhere from file reads, tool output, or model text — by
diffing it against the previous frame and writing raw ANSI/OSC/APC escape sequences directly to
`process.stdout`; it does not sanitize or allow-list escape sequences in that content (only its own
width/wrap logic understands a narrow set of CSI/OSC/APC forms for layout purposes). It can invoke two
external processes: `fd` (via `child_process.spawn`) for path/file autocompletion as the user types, and
`tmux display-message` (via `execSync`) to probe hyperlink-forwarding support — both read-only, non-shell
argv-array invocations. It loads a native `.node` addon via `createRequire`/dynamic `require()` for
platform-specific keyboard-modifier/console-mode detection (macOS/Windows only), reads roughly twenty
environment variables to fingerprint the terminal emulator, and writes debug/crash logs and an optional
full write-log to disk. On explicit user mouse actions it can copy on-screen text to the OS clipboard via
OSC 52 and can ask an injected `openUrl` callback (owned by `packages/coding-agent`, out of scope here) to
open a URL the user clicked.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `packages/tui/src/autocomplete.ts:164` | `spawn(fdPath, args, …)` — runs the `fd` binary to list files for path/`@file` autocompletion | user types a path-like token or presses Tab in the prompt editor | argv-array spawn (no shell interpretation); `signal`-based kill on abort; `fdPath` is passed in by the caller (`packages/coding-agent`), not resolved here | Partially. The query text (from user keystrokes) becomes one argv element via `buildFdPathQuery`/regex-escaping, so no shell injection. `fdPath` itself is caller-supplied — if the binary at that path is attacker-controlled or was fetched without integrity verification (flagged separately, task #12 in this audit), this call executes it with no further check. |
| `packages/tui/src/terminal-image.ts:54` | `execSync("tmux display-message -p '#{client_termfeatures}'", …)` — probes whether the attached tmux forwards OSC 8 hyperlinks | automatic, on terminal-capability detection at startup / when `TMUX` env is set | fixed string command (not built from input), `timeout: 250`, stdio `ignore` for stdin/stderr, wrapped in try/catch | No. Command is a hardcoded literal; only reachable when `process.env.TMUX` is set, which is not attacker-controlled input to this function. |

All other sweep `process-exec` hits in this scope (`autocomplete.ts:1` import line, `editor.ts:1303`,
`markdown.ts:11,102,107,112,116,128,162,744,749`, `latex.ts:947`, `terminal-image.ts:309,311,349,384`,
`tui-alt-screen.ts:408,449`, `utils.ts:351`, `word-navigation.ts:102`) are `RegExp.prototype.exec()` calls —
see Dismissed section.

### dynamic-code

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `packages/tui/src/native-modifiers.ts:5,45` | `createRequire(import.meta.url)` then `cjsRequire(modulePath)` to load a prebuilt native addon (`darwin-modifiers.node` / `win32-console-mode.node`) that reports whether Shift/Cmd/Ctrl/Option are physically held | automatic at first keypress needing modifier state (macOS/Windows only; no-op on Linux/other arches) | `arch`/`platform` allow-list before any require; candidate paths are fixed, relative to the module's own install directory or `process.execPath`; each `require()` wrapped in try/catch, falls back to `false` on any failure; return value is runtime-validated (`isNativeModifiersHelper`) before use | Low. Paths are derived from the package's own on-disk location, not from user/model/file input. Risk is supply-chain (a tampered `.node` file shipped in the package tree), not runtime injection. |
| `packages/tui/src/terminal.ts:9,365` | Same pattern, `win32-console-mode.node`, to enable `ENABLE_VIRTUAL_TERMINAL_INPUT` on Windows consoles | automatic at terminal `start()` on Windows | same fixed-candidate-path + try/catch pattern as above | Low, same reasoning. |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `packages/tui/src/terminal.ts:119-132,466-467` | Appends every byte written to the terminal to a log file, when `PI_TUI_WRITE_LOG` is set (path or directory) | opt-in via env var, then every `terminal.write()` call for the session | only active if env var set; wrapped in try/catch; if the env value is an existing directory a timestamped filename is generated, else used as-is | Env var is operator-controlled (not model/file-controlled), but this is a **T4-relevant capability**: since all TUI output is logged verbatim, any secret or token ever rendered to the screen (env dumps, pasted keys, model output echoing a leaked credential) lands in plaintext at this path. No permission-hardening (uses default `appendFileSync` mode) or symlink check. |
| `packages/tui/src/tui-main-screen.ts:253-259` | Debug redraw log to `<logDirectory>/pi-debug.log`, gated by `PI_DEBUG_REDRAW=1` | opt-in via env var, every render | `mkdirSync(..., {recursive:true})` + `appendFileSync`; no symlink/permission check | Low; debug-only, logDirectory defaults to `~/.pi/agent` or `PI_CODING_AGENT_DIR`. |
| `packages/tui/src/tui-main-screen.ts:449-460` | Crash log `<logDirectory>/pi-crash.log` containing **all rendered lines** (full screen content) written when a line overflows terminal width (a rendering bug, not user-triggered) | automatic on an internal invariant violation | none beyond directory creation | Not attacker-triggered directly, but the crash dump captures whatever was on-screen (could include secrets) into a persistent file — T4 concern if that invariant can be provoked by content of a specific visible width (e.g., a very long unbroken token in file/tool output that a custom component fails to wrap). |
| `packages/tui/src/tui-main-screen.ts:499-501,525` | Verbose per-render debug dump to `/tmp/tui/render-<ts>-<rand>.log`, gated by `PI_TUI_DEBUG=1` | opt-in via env var, every render | none beyond `mkdirSync(recursive:true)` | See temp-paths row below — same predictable shared-tmp-dir pattern as upstream's fixed CVEs, though gated behind an explicit debug flag (off by default). |

### env

22 hits, all read-only fingerprinting/feature-flag checks: terminal-emulator detection
(`terminal-image.ts:69-108` — `TERM_PROGRAM`, `TERMINAL_EMULATOR`, `TERM`, `COLORTERM`, `TMUX`,
`KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `WEZTERM_PANE`, `WARP_SESSION_ID`/`WARP_TERMINAL_SESSION_UUID`,
`ITERM_SESSION_ID`, `WT_SESSION`), platform quirks (`terminal.ts:41` Apple Terminal, `tui-main-screen.ts:43`
Termux), debug/behavior toggles (`PI_TUI_WRITE_LOG`, `PI_DEBUG_REDRAW`, `PI_TUI_DEBUG`, `PI_HARDWARE_CURSOR`,
`PI_CLEAR_ON_SHRINK`, `PI_CODING_AGENT_DIR`), and terminal-size fallback (`COLUMNS`/`LINES` in `terminal.ts:475,479`
when `process.stdout.columns/rows` is unavailable, e.g. piped output). None of these write anywhere or
change trust decisions; they only pick a rendering code path. Not attacker-influenceable in the T1/T2 sense
(these are the operator's own process environment, set before the harness starts).

### temp-paths

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `packages/tui/src/tui-main-screen.ts:500` | Hardcoded `/tmp/tui` debug-dump directory (world-writable shared tmp on most POSIX systems), `mkdirSync(recursive:true)` then per-render `writeFileSync` | opt-in via `PI_TUI_DEBUG=1` | none — no `O_EXCL`/`O_NOFOLLOW`, no ownership/permission check on the directory before writing into it | T3-relevant: a **sibling of the fixed CVE-2026-54328 pattern** (predictable temp install path). Here it's a debug log, not a code path that gets executed, so it's not an RCE/priv-esc primitive by itself — but a local attacker who pre-creates `/tmp/tui` as a symlink to a file/dir the target user can write could cause `pi-tui` to write render dumps (which may include on-screen secrets, see fs-write row above) through that symlink to an attacker-chosen location. Mitigated only by the fact this path is disabled by default. |

### trust

All 5 sweep `trust` hits (`editor.ts:697`, `select-list.ts:125`, `settings-list.ts:186`, `keybindings.ts:42,146`)
are dismissed as false positives — see below. This area implements no trust/approval decisions itself; it
renders whatever it is given and reports raw key/mouse events upward.

### credentials / deserialize

No hits in scope, and none found by reading. `pi-tui` never touches API keys, OAuth tokens, `auth.json`, or
session files, and does not parse any serialized format beyond its own small regex-based ANSI/OSC parsers
(no `JSON.parse` of untrusted network/file data, no `eval`/`Function`/`vm` anywhere in the package).

## Dismissed sweep hits (with reason)

- **`process-exec` regex false positives** — `autocomplete.ts:1` (`import { spawn }` — the import statement
  itself, counted because the sweep is line-text based; the real call is line 164, listed above),
  `editor.ts:1303`, `markdown.ts:11,102,107,112,116,128,162,744,749`, `latex.ts:947`,
  `terminal-image.ts:309,311,349,384`, `tui-alt-screen.ts:408,449`, `utils.ts:351`, `word-navigation.ts:102`.
  All of these are `RegExp.prototype.exec()` (or `.exec(` inside a member expression on a compiled regex),
  matched by the sweep's `exec(` substring pattern for `child_process.exec`. They parse markdown tokens,
  LaTeX modifiers, ANSI/mouse escape sequences, or paste markers — no subprocess involved.
- **`trust` hits are all `kb.matches(data, "tui.select.confirm")`** (`editor.ts:697`, `select-list.ts:125`,
  `settings-list.ts:186`) plus the two `keybindings.ts` definitions of that same keybinding id. The sweep's
  `trust` regex matched the substring `confirm`/`trust`-adjacent wording; this is ordinary keybinding
  dispatch (does the pressed key match the "confirm selection" binding?), not an approval/trust gate.

## Capabilities found by reading, missed by the sweep

- **Raw escape-sequence passthrough to the real terminal is unbounded.** `Text.render()`
  (`components/text.ts`) and `Markdown`/code-block rendering (`components/markdown.ts`) concatenate whatever
  string content they're given (which can originate from file contents, tool output, or model text composed
  upstream in `packages/coding-agent`) into the lines that `TuiMainScreen`/`TuiAltScreen` write verbatim to
  `process.stdout` (`tui-main-screen.ts` `fullRender`/differential-render paths, `terminal.ts:463-472
  write()`). The package's own `extractAnsiCode`/`stripTerminalSequences`/`visibleWidth` helpers
  (`utils.ts:298-444`) only recognize a narrow allow-list of CSI (`m`/`G`/`K`/`H`/`J` final bytes), OSC, and
  APC forms for width/wrap accounting — they are not applied as a sanitizing filter on the render path
  itself. Any other literal control bytes or escape sequences embedded in displayed content (e.g. a file
  containing raw OSC 52, title-set, or terminal-quirk-exploiting sequences, echoed by a "read file" or "run
  command" tool) reach the terminal unmodified. This is the classic "terminal escape sequence injection via
  untrusted content" class; whether it's exploitable depends entirely on what `packages/coding-agent` passes
  in, which is out of this file's scope but worth flagging as a boundary question (see below).
- **OSC 52 clipboard write is a real, if user-gated, exfiltration-adjacent primitive.**
  `tui-alt-screen.ts:716-739 copySelectionToClipboard()` writes `\x1b]52;c;<base64>\x07` — the OS clipboard
  set sequence — containing whatever on-screen text the user selected with the mouse. Requires an actual
  mouse drag+release from the user (`handleSelectionMouseEvent`, `tui-alt-screen.ts:621-678`); it cannot be
  triggered by model output or file content alone. Noted because it's a capability (write access to the
  host clipboard) that a casual reader of "it's just a renderer" might miss.
  Additionally, `stripTerminalSequences` is applied to the selected text before encoding, so a captured
  selection containing embedded escape codes cannot smuggle a second nested OSC 52 write.
- **Click-to-open-URL is a rendering-layer trigger for an out-of-scope process-exec.**
  `tui-alt-screen.ts:631-648` resolves the OSC 8 hyperlink under a mouse click (`getOsc8LinkAtColumn`,
  `utils.ts:344-366`) and calls an injected `openUrl` callback. `packages/coding-agent/src/modes/interactive/
  interactive-mode.ts:345` wires this to `openBrowser` (outside this scope), which presumably spawns the OS
  browser opener. The hyperlink URL itself can originate from any rendered content, including model output
  or markdown links in file content (`components/markdown.ts` renders link syntax as OSC 8). So: file/model
  content can make a URL clickable and pre-filled for the user to click; a human click is still required to
  reach any process-exec, but the URL text shown to the user is attacker-controlled and could be used for
  social engineering (misleading display text vs. actual href) — worth checking upstream in the
  `interactive-mode`/`openBrowser` capability map for how the URL is validated before spawning.
- **`SIGWINCH` self-signal.** `terminal.ts:163 process.kill(process.pid, "SIGWINCH")` — sends a real-time
  signal to itself on `start()` to force a terminal-size refresh after suspend/resume. Not attacker-relevant
  (targets own PID with a benign signal) but is a `process.kill` call the sweep's `process-exec` regex
  (which looks for `spawn`/`exec`/`fork`-shaped calls) did not pick up.
- **Native Windows console-mode mutation.** `terminal.ts:347-375 enableWindowsVTInput()` calls into the
  dynamically-loaded native addon to flip a console mode flag (`ENABLE_VIRTUAL_TERMINAL_INPUT`) on the real
  stdin handle. Grouped under dynamic-code above, but the side effect (mutating console mode) is a distinct,
  unflagged capability worth naming explicitly.

## Questions for the human reviewer

1. Where in `packages/coding-agent` (out of this file's scope) is text sanitized, if at all, before being
   handed to `Text`/`Markdown`/`TruncatedText` for rendering? If tool output or file contents are passed
   through with embedded raw escape sequences, this package will write them to the real terminal unmodified
   (see "Raw escape-sequence passthrough" above) — please confirm whether that's an accepted trade-off
   (needed for legitimate ANSI-colored tool output) or a gap.
2. Is `fdPath` (passed into `CombinedAutocompleteProvider`, executed at `autocomplete.ts:164`) resolved from
   a vendored/pinned binary, or fetched at install/runtime? This ties into task #12 in this audit
   ("Mitigate unverified rg/fd binary download") — the execution site lives here even though the
   fetch/resolution logic does not.
3. `PI_TUI_WRITE_LOG` and `PI_TUI_DEBUG` both write full-fidelity captures of everything rendered to the
   terminal (including anything a model ever echoed, such as pasted secrets or `env` output) to disk in
   plaintext with default file permissions. Confirm these are meant to be developer-only flags never set in
   production/CI, since there's no redaction and (`/tmp/tui`) no protection against a local shared-tmp
   symlink attack (T3) when `PI_TUI_DEBUG=1` is set on a multi-user box.
4. `openUrl`/`openBrowser` (wired in `packages/coding-agent`) is reachable from a single mouse click on any
   OSC 8 hyperlink rendered from model or file content. Please verify in that package's capability map
   whether the URL is validated (scheme allow-list, no `file://`/`javascript:`-style tricks) before being
   handed to whatever opens it.
