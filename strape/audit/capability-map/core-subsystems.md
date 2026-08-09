# Compaction, HTML export, RPC, client

## Scope (files + LOC)

`packages/coding-agent/src/core/compaction/`, `core/export-html/`, `modes/rpc/`, `client/` — 18 files, 7,542 LOC total (incl. `template.css`/`template.html` markup and two vendored minified JS libraries).

| file | LOC | role |
|---|---|---|
| `core/compaction/branch-summarization.ts` | 376 | summarize an abandoned session-tree branch when the user navigates away from it |
| `core/compaction/compaction.ts` | 969 | context-window compaction: cut-point selection + LLM summarization of old turns |
| `core/compaction/utils.ts` | 158 | shared file-op extraction / conversation serialization for both of the above |
| `core/compaction/index.ts` | 7 | barrel re-export |
| `core/export-html/index.ts` | 316 | builds a self-contained offline HTML file from a session (`/export`, CLI `--export`, RPC `export_html`) |
| `core/export-html/ansi-to-html.ts` | 258 | ANSI SGR → inline-styled HTML converter, used to pre-render custom tool output |
| `core/export-html/tool-renderer.ts` | 172 | invokes extension `renderCall`/`renderResult` and pipes their ANSI output through the converter above |
| `core/export-html/template.html` | 55 | export page skeleton — no external resources, session data embedded as base64 in a `<script type="application/json">` |
| `core/export-html/template.css` | 1,066 | export page styling (no capability sites) |
| `core/export-html/template.js` | 1,864 | in-browser renderer for the exported page: decodes the base64 blob, runs a hardened `marked`/`hljs` markdown pipeline, builds the DOM |
| `core/export-html/vendor/marked.min.js` | 78 | vendored Markdown parser (v18.0.5), used only inside the exported HTML, never at harness runtime |
| `core/export-html/vendor/highlight.min.js` | 1,212 | vendored syntax highlighter (v11.9.0), same as above |
| `modes/rpc/rpc-mode.ts` | 817 | the RPC server loop: reads JSON commands from stdin, drives an `AgentSessionRuntime`, writes events/responses to stdout |
| `modes/rpc/rpc-client.ts` | 601 | the RPC client SDK: spawns `node <cliPath> --mode rpc ...` as a child process and talks to it over its stdio |
| `modes/rpc/rpc-types.ts` | 289 | wire protocol type definitions (commands, responses, extension-UI request/response) |
| `modes/rpc/jsonl.ts` | 58 | strict LF-only JSONL framing shared by both ends of the RPC pipe |
| `client/remote-session.ts` | 420 | state machine wrapping `@earendil-works/pi-client` (out of scope) for a server-mode/shared-session UI |
| `client/transcript.ts` | 101 | applies streamed transcript deltas (incl. partial tool-call JSON) to local state |
| `client/index.ts` | 15 | barrel re-export |

`git diff v0.84.0..HEAD -- <these paths>` is empty: none of the 6 strape hunks touch this area — everything here is byte-identical unmodified upstream v0.84.0 code.

## What this area can do (prose)

This area has three distinct jobs. **Compaction** (`core/compaction/`) is pure logic plus one network-shaped side effect: it walks session history to pick a cut point, serializes the discarded messages to plain text, and calls out to the *currently configured* LLM provider (via `@earendil-works/pi-ai`'s `completeSimple`/`streamFn`, outside this scope) using an `apiKey`/`headers`/`env` bundle that the caller (`agent-session.ts`) already resolved — so anything the agent read into context (including file contents that might be secrets) gets serialized and sent over the network again as part of the summarization prompt. **HTML export** (`core/export-html/`) reads the session's own JSONL and template assets from fixed package-relative paths, base64-embeds the session JSON into a static offline HTML page, and writes it with `writeFileSync` to a caller-supplied path with no path confinement; the in-browser renderer (`template.js`) is the direct descendant of the code that shipped CVE-2026-54326 (HTML-export XSS), and it now defends carefully — HTML/tag tokenizers are disabled in `marked`, link/image URLs are scheme-allowlisted, and every other dynamic field goes through a local `escapeHtml()` before hitting a template literal; I verified this against `javascript:`/`data:`/raw-`<script>`/`<img onerror>` payloads with the actual vendored `marked.min.js` and all were neutralized. **RPC mode** (`modes/rpc/`) is a headless JSON-over-stdio protocol for embedding the agent in a host application: whoever writes to the child process's stdin can prompt the agent, execute arbitrary shell commands (`bash` command, no extra approval layer visible in this file), point the session at any session file on disk (`switch_session`), or make the process write an HTML export to any path it can reach (`export_html`) — this is by design (the RPC host is the trust boundary, analogous to a human at the TUI), but it means the approval/consent story for tool calls made *by the model* during an RPC session is not implemented in this file and must live entirely in the shared session/extension code outside this scope. The **client** files are thin, capability-free state managers: `remote-session.ts` orchestrates a `pi-client`/`pi-protocol` session lease (all actual network I/O is in the out-of-scope `packages/client`), and `transcript.ts` incrementally reassembles streamed (and possibly incomplete) tool-call JSON with a prototype-pollution-safe custom validator.

## Capability inventory

### network (indirect — 0 sweep hits, but present)

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `compaction.ts:670` (`completeSummarization`→`completeSimple`/`streamFn`) | Outbound HTTPS call to the active LLM provider carrying the full serialized conversation-to-be-summarized plus `apiKey`/`headers`/`env` | Automatic whenever `shouldCompact()` trips (context window near full) or user runs `/compact` / RPC `compact` | Uses the same already-resolved provider credentials as the main chat call (`_getSummarizationRequestAuth`, out of scope); `cacheRetention:"none"` and a fresh `sessionId` isolate it from the main request cache | Message content is attacker-influenceable under T1 (any file the agent read, including secrets, becomes summarization-prompt text sent to the provider again); the *destination* (which provider) is operator-configured, not attacker-controlled |
| `branch-summarization.ts:351` (`completeSummarization`) | Same mechanism, triggered when navigating away from a session-tree branch (`/fork`, RPC `fork`/`navigateTree`) | User navigates the session tree | Same as above | Same as above |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `export-html/index.ts:280` (`exportSessionToHtml`) | `writeFileSync(outputPath, html, "utf8")` — writes the generated export HTML | User `/export` (TUI), CLI `--export`, or RPC `export_html` command | `outputPath` only passed through `normalizePath()` (expands `~`, resolves `file://`) — **no containment to cwd/session dir**; defaults to a `pi-session-<name>.html` in the current directory if omitted | Path/overwrite target is caller-supplied. Not reachable from a model tool call (no `export_html`-equivalent tool exists) or from raw file content — the caller is a human (TUI/CLI) or an RPC host process that already has the strictly stronger `bash` RPC command available |
| `export-html/index.ts:314` (`exportFromFile`) | Same `writeFileSync`, for the CLI's stand-alone "export an arbitrary session file" path | CLI `--export <path>` | Same as above | Same as above; `inputPath` is also resolved with no confinement, so this doubles as an arbitrary-file-read-then-render-into-HTML primitive gated only by CLI invocation |

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `rpc-client.ts:94` | `spawn("node", [cliPath, ...args], { cwd, env: {...process.env, ...this.options.env}, stdio:["pipe","pipe","pipe"] })` — spawns the agent itself in RPC mode as a child process | Any embedder constructing `new RpcClient(options)` and calling `.start()` (SDK entry point; only exercised by this package's own tests today, not called anywhere else in `packages/coding-agent/src`) | None — `cliPath` (default `"dist/cli.js"`, a relative path resolved against whatever the embedding process's cwd happens to be) and `args`/`env` are taken verbatim from caller-supplied `RpcClientOptions` | If an embedding application ever sourced `cliPath`/`args`/`env` from untrusted config (e.g. a workspace `.json` file), this is a direct `node <attacker-path>` execution primitive. As shipped, nothing in this repo feeds attacker data into it |
| `rpc-mode.ts:559-580` (`case "bash"`) | Runs an arbitrary shell command via `session.executeBash(command.command, ...)` (delegates to the same `bash` execution path as the interactive `!command` prefix) | Any RPC command of `type:"bash"` received on stdin | None in this file — no confirmation round-trip is issued before running it (unlike `confirm`/`select`/`input`, which do round-trip to the RPC peer); treated as an already-approved, explicit user action, same trust level as typing `!cmd` in the TUI | Fully controlled by whoever can write to the child process's stdin — i.e., the RPC host application. Not reachable from model tool calls or file content in this file |

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `compaction.ts:539-553,668` (`createSummarizationOptions`) | Threads `apiKey`/`headers`/`env` (already resolved by the caller) into `SimpleStreamOptions` for the outbound summarization call | Every compaction/turn-prefix summarization | No storage, no logging observed in this file; values pass straight through to the network call above | Not attacker-writable — it's a plumbing parameter, not a secret source. Flagged here because it's the last in-scope hop before the credential leaves the process over the network |
| `branch-summarization.ts:71,299,350` | Same pattern for branch summaries (`GenerateBranchSummaryOptions.apiKey` → `SimpleStreamOptions`) | Branch navigation | Same | Same |
| `compaction.ts:542,548,591,607,626,668,820,853,871,889,928,955` | Remaining `apiKey` parameter declarations/pass-throughs across `compact()`/`generateSummary*()`/`generateTurnPrefixSummary()` | n/a (function signatures) | n/a | Pure plumbing, no independent risk beyond the network call above |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `rpc-mode.ts:751` (`handleInputLine`) | `JSON.parse(line)` on every line read from stdin | Every RPC command | `try/catch`; parse failure returns a `type:"parse"` error response instead of throwing | Content is whatever the RPC host writes — trusted boundary by design, but this is the sole parser standing between "bytes on a pipe" and executing the `bash`/`switch_session`/etc. commands above |
| `rpc-client.ts:510` (`handleLine`) | `JSON.parse(line)` on every line read from the spawned child's stdout | Every response/event from the RPC child process | Wrapped in `try/catch`; non-JSON lines are silently dropped | Data originates from the child agent process this same client spawned — same trust domain |
| `client/transcript.ts:20` (`parsePartialToolInput`) | `JSON.parse(value)` on a streamed, possibly-incomplete tool-call argument buffer | Every `session_progress` "toolCall" delta event from a remote server session | `try/catch` falls back to the raw string; result is additionally passed through `isJsonValue()`, a recursive structural check (`Object.getPrototypeOf(v) === Object.prototype`) that rejects non-plain-object values before they're stored — blocks the classic `{"__proto__":{...}}` JSON-parse prototype-pollution vector from tainting shared prototypes | Value is server/model-controlled (tool-call arguments as they stream token-by-token); worst case if it parses to something unexpected is a malformed value rendered in the transcript UI, not code execution |

### trust

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `rpc-mode.ts:136-311` (`createExtensionUIContext`) | Implements the `confirm`/`select`/`input`/`editor` extension-UI methods by round-tripping an `extension_ui_request`/`extension_ui_response` pair over the RPC pipe, with a timeout that resolves to a safe default (`false`/`undefined`) if the peer never answers | Called by extension code (via `ExtensionUIContext`) when it needs to ask the user something, e.g. `llama/index.ts`'s "Unload model?" confirm | Timeout defaults fail closed (`confirm`→`false`); genuinely depends on the RPC host actually surfacing the prompt to a human rather than auto-answering | This is the **only** human-in-the-loop primitive visible in this file. It is wired to `ExtensionUIContext`, used by extension-authored confirmations — I did not find a parallel "approve this tool call" RPC message type in `rpc-types.ts`, so core tool-call approval (for `bash`/`write`/`edit` invoked *by the model*) is not implemented in this directory and must be enforced identically to interactive mode by shared code outside this scope (see Questions) |
| `rpc-types.ts:240,282` | Wire-format type definitions for the `confirm` request/response pair described above | n/a (types) | n/a | n/a |

## Dismissed sweep hits (with reason)

- `export-html/ansi-to-html.ts:207,235` — `ANSI_REGEX.exec(text)`. Sweep matched the substring `exec(`; this is `RegExp.prototype.exec`, not process execution. No child process involved.
- `modes/rpc/rpc-client.ts:379` (`async fork(entryId): ...`), `rpc-mode.ts:326,610,622` (`runtimeHost.fork(...)`) — sweep matched the identifier `fork`. These all refer to **session-tree forking** (branching the conversation history at a chosen entry, implemented in the out-of-scope `agent-session-runtime.ts`), not `child_process.fork`/POSIX `fork(2)`. Confirmed by reading `AgentSessionRuntime.fork()`, which only manipulates `SessionManager` state and returns `{cancelled, selectedText}`.
- `compaction.ts`/`branch-summarization.ts` `apiKey` hits (all 14) — these are function-parameter names/declarations for already-resolved credentials being threaded through to a network call, not hardcoded secrets, credential storage, or credential logging. Kept in the credentials table above (not silently dropped) because they are the last in-scope hop before the key leaves the process, but there is no vulnerability at these specific lines.

No other sweep hits fell inside this scope's file set (34 total hits matched; all addressed above or in the tables).

## Capabilities found by reading, missed by the sweep

- **Outbound network calls from compaction/branch-summarization** (see network table above). The sweep's `network` regex class recorded zero hits in this scope because the actual HTTP call lives inside `@earendil-works/pi-ai`'s `completeSimple`/`streamFn` (a different package); `compaction.ts` and `branch-summarization.ts` only reference `SimpleStreamOptions`/`apiKey`/`headers`. Reading the call graph (`completeSummarization` → `streamFn`/`completeSimple`) shows this area is a genuine network-triggering site that the regex sweep structurally cannot see.
- **Arbitrary local file read via `switch_session` / `exportFromFile`.** None of the sweep's 9 classes include a generic "fs-read" bucket, so `SessionManager.open(resolvedInputPath)` (CLI `--export`) and `SessionManager.open(sessionPath, ...)` (RPC `switch_session`, in the out-of-scope `agent-session-runtime.ts` but triggered from `rpc-mode.ts:602`) don't show up anywhere in the sweep despite being a real "read any file the OS user can reach and parse it as session JSONL" capability.
- **`export_html`/`exportToHtml` fan-out.** The sweep only flagged the two `writeFileSync` call sites inside `export-html/index.ts`; it has no way to show that both are reachable from three different triggers (TUI `/export`, CLI `--export`, and RPC `export_html`), one of which (RPC) hands the output path directly to an external, non-interactive caller.
- **Unbounded input buffer in `jsonl.ts`.** `attachJsonlLineReader` accumulates `buffer += chunk` with no maximum size before finding a `\n`; a peer that sends an arbitrarily long line without ever terminating it will grow this buffer without bound. Minor local-DoS note (T3-adjacent), not flagged by any sweep class since it's an absence-of-a-check, not a matched pattern.
- **`rpc-client.ts:104` (`process.stderr.write(data)`)** forwards the spawned agent child's raw stderr to the parent's stderr. If the child process ever prints a credential or stack trace containing one to stderr (outside this scope's code), this SDK helper republishes it — worth a T4 mention even though no sweep class covers "log forwarding."
- **The XSS-hardening in `template.js` is real and I verified it, not just present.** I extracted the vendored `marked.min.js`, reproduced the exact `marked.use({...})` configuration from `template.js` (disabled `html`/`tag` tokenizers, scheme-allowlisted `link`/`image` renderers, `escapeHtml` everywhere else), and ran it against `<img onerror>`, `<script>`, `<svg onload>`, `javascript:`-scheme links (plain, `<...>`-autolink, mixed-case, leading-space), and a `data:` URI image — all were neutralized (either HTML-escaped to inert text or the URL was stripped to plain text). This is the direct code path CVE-2026-54326 was fixed in; I did not find a regression.

## Questions for the human reviewer

1. Is per-tool-call approval for model-initiated `bash`/`write`/`edit` tool calls (as opposed to the `bash`/`write` capabilities *directly exposed as RPC commands*, which are pre-approved by design) enforced identically when running under `modes/rpc/rpc-mode.ts` as it is in `modes/interactive/`? This file contains no approval/confirmation gate for tool calls the model itself makes mid-session — only the extension-authored `confirm`/`select`/`input` UI round-trip. Please confirm the shared session/extension-runner code (out of this scope) applies the same gate regardless of mode.
2. `RpcClient.start()` (`rpc-client.ts:94`) spawns `node <cliPath>` with attacker-shaped inputs (`cliPath`, `args`, `env`) taken verbatim from `RpcClientOptions`. Nothing in this repo currently feeds untrusted data into those fields (only test code instantiates `RpcClient`), but since it's an exported public SDK surface (`src/index.ts`), is there a documented expectation for embedders about not sourcing these from project-controlled config (T1)?
3. `export-html/index.ts`'s `outputPath`/`inputPath` handling has zero path confinement (arbitrary absolute path write/read, `~`-expansion via `normalizePath`). This mirrors the `write`/`edit` tools' lack of workspace jail (see the sibling `core/tools/` capability map), so it may be intentional harness-wide policy rather than a local gap — worth confirming it's the same accepted-risk decision rather than an oversight specific to export.
4. Both vendored libraries (`marked.min.js` v18.0.5, `highlight.min.js` v11.9.0) are copied into the source tree rather than pulled from `node_modules` at build time. Is there a process that re-vendors/diffs these against upstream releases (to catch a tampered vendor commit), and is that covered by the dependency-closure review (Job B) rather than this source review?
