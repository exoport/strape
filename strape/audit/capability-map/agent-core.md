# pi-agent-core

## Scope (files + LOC)

`packages/agent/src/` (upstream `pi-agent-core`, unmodified by strape's hunks) — 48 TypeScript files,
~12,177 LOC (`agent/src/**/*.ts`, `wc -l`), 10,292 LOC excluding blank/whitespace-only diff noise across the
harness subtree used for this table. Key subdirectories:

- `agent.ts`, `agent-loop.ts`, `stream-fn.ts`, `proxy.ts`, `node.ts`, `types.ts`, `index.ts` — top-level
  agent runtime, LLM streaming glue, optional proxy transport, Node environment factory, public exports.
- `harness/agent-harness.ts`, `harness/types.ts`, `harness/result.ts`, `harness/messages.ts`,
  `harness/reducer.ts`, `harness/system-prompt.ts`, `harness/skills.ts`, `harness/prompt-templates.ts`,
  `harness/telemetry.ts` — durable multi-lane harness scaffold (largely `HarnessNotImplemented` stubs in
  this release), message/entry types, skill & slash-command loading, telemetry schema.
- `harness/env/nodejs.ts` — the concrete `ExecutionEnv`: all real process spawning and filesystem I/O.
- `harness/tools/*` — the model-facing tools: `bash.ts`, `edit.ts`, `write.ts`, `read.ts`, `image.ts`,
  `file-mutation-queue.ts`, `path-utils.ts`, `tool-context.ts`.
- `harness/session/**` — durable JSONL session log (`jsonl/storage.ts`, `jsonl/codec.ts`, `jsonl/repo.ts`,
  `jsonl/errors.ts`, `jsonl/types.ts`), in-memory session backend (`memory.ts`), session tree/state machine
  (`session.ts`, `state.ts`), query helpers (`search.ts`, `context.ts`), conformance test harness
  (`testing/*.ts`).
- `harness/compaction/*` — context-window compaction and branch summarization (calls back into the LLM).
- `harness/utils/{shell-output,truncate}.ts` — bash output capture/truncation/spill-to-temp-file.

This package is a **library**, not the CLI. It defines tool implementations and the run loop but exposes
every trust decision (`beforeToolCall`/`afterToolCall`, `getApiKey`, `streamFn`) as caller-supplied hooks. A
host application (outside this scope) is responsible for wiring approvals; nothing in this package enforces
one by default.

## What this area can do (prose, 1 para)

This is the part of strape that actually touches the outside world on the model's behalf. Through
`NodeExecutionEnv` (`harness/env/nodejs.ts`) it can spawn arbitrary shell commands with the full inherited
process environment (`spawn(shell, ["-c", command], { env: {...process.env, ...} })`), kill process trees,
and perform unrestricted filesystem reads/writes/renames/deletes/mkdir/rm -rf and temp-file creation anywhere
the OS user can reach — there is no path allowlist or workspace jail anywhere in this package. The `bash`,
`edit`, and `write` tools expose exactly those primitives to the model with no built-in confirmation step;
gating is delegated entirely to an optional `beforeToolCall` hook that the host application must supply
(`agent-loop.ts:619-643`). It resolves and forwards LLM provider API keys and, if a host opts into
`streamProxy` (`proxy.ts`), can POST the entire conversation context plus a bearer token to an
application-configured URL. It persists the full conversation, tool calls, and tool outputs (including file
contents the model read) as an append-only JSONL session log on disk, with explicit anti-corruption
(torn-tail repair) and anti-prototype-pollution (`assertJsonSerializable`) guards. It loads and parses
YAML/Markdown frontmatter for skills and slash-command templates from disk locations that can include
repository content, but only ever turns that into system-prompt *text* — this package contains no
extension/plugin loader and no `eval`/`vm`/dynamic `import()` of any kind.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `harness/tools/bash.ts:59-159` | `bash` tool: runs a model-supplied string as a shell command, captures stdout/stderr, spills to a temp file if large | model emits a `bash` tool call | none in this package; `options.prepare` hook and `commandPrefix` are host-supplied, no default confirmation | Yes — direct: command text comes from model output (T2), which is itself steerable by injected repo content (T1) |
| `harness/env/nodejs.ts:367-500` (`NodeExecutionEnv.exec`) | Actual `child_process.spawn` of the resolved shell (`/bin/bash -c`, `sh -c`, or Git-Bash on Windows) with `detached: true` so the whole process group can be killed | called by `bash` tool via `executeShellWithCapture` | timeout + AbortSignal → `killProcessTree`; no command allowlist/sandboxing | Yes |
| `harness/env/nodejs.ts:145-169` (`runCommand`) / `:171-179` (`findBashOnPath`) | Spawns `which`/`where bash.exe` to *locate* a shell binary | startup, first `exec()` call, or explicit shell discovery | 5s timeout only | No (fixed argv, no user data) |
| `harness/env/nodejs.ts:253-276` (`killProcessTree`) | Sends `SIGKILL` to a process group (`process.kill(-pid,...)`) or spawns `taskkill /F /T /PID <pid>` on Windows | timeout, abort, or `env.cleanup()` | pid is the harness's own spawned child; not attacker-suppliable | No (pid produced internally) |
| `harness/utils/shell-output.ts:146-155` | Wraps `env.exec` with output capture/truncation for the `bash` tool | every `bash` invocation | same as above | Yes (same command text) |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `harness/tools/write.ts:26-36` | `write` tool: create/overwrite arbitrary file at a model-supplied path, auto-creating parent dirs | model tool call | `withFileMutationQueue` only serializes concurrent writes to the same path — no path allowlist, no workspace jail | Yes — path and content both model-controlled |
| `harness/tools/edit.ts:89-124` | `edit` tool: read → apply exact-text replacements → write back, with BOM/line-ending preservation | model tool call | same mutation-queue serialization; no path restriction | Yes |
| `harness/env/nodejs.ts:555-583` (`writeFile`/`appendFile`) | Underlying `fs.writeFile`/`fs.appendFile`, always `mkdir(..,{recursive:true})` first | any tool/session write | none (by design — mirrors what direct filesystem/bash access already permits) | Yes, transitively |
| `harness/env/nodejs.ts:585-600` (`renameFile`) | Atomic rename, used for session `.tmp` → real-path publication | session storage internals | none beyond OS atomicity | No (paths are the harness's own session paths, not user input) |
| `harness/env/nodejs.ts:651-669` (`createDir`/`remove`) | `mkdir -p` / `rm -rf` equivalents exposed on `ExecutionEnv` | any tool/session code path that calls them (no built-in tool currently calls `remove` directly, but the interface is public) | none | Depends on caller |
| `harness/session/jsonl/storage.ts:33-46,59-109` (`publishFileAtomically`, `create`, `fork`) | Writes session header/mutations, does atomic temp-file-then-rename publication for session creation and forking | every prompt/tool-result/compaction/lane event; explicit "fork session" action | `assertJsonSerializable` (see below) validates payload shape before persisting; mutation queue (`enqueue`) serializes writers per storage instance | Message/tool-result *content* is attacker-influenced (T1/T2), but structure is schema-validated |
| `harness/session/jsonl/storage.ts:258` (`appendMutation`) | Appends one JSON line per session mutation (message, tool result, usage, lane change) | every harness state change | none beyond `assertJsonSerializable` upstream of this call | Yes (content), No (control-plane fields) |
| `harness/utils/shell-output.ts:70-91` | Spills full (untruncated) bash output to a temp file (`bash-*.log`) when output exceeds the inline cap | large/long-running bash output | temp file lives under a freshly `mkdtemp`'d 0700 directory (see temp-paths) | Yes — content is command output |

### temp-paths

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `harness/env/nodejs.ts:671-677` (`createTempDir`) | `mkdtemp(join(os.tmpdir(), prefix))` — Node appends a random suffix; not a caller-guessable path | every `createTempFile` call (bash output spill, generic temp needs) | relies on Node/libuv's random suffix and default `0700` directory mode to resist the CVE-2026-54328 "predictable temp path" class | prefix string can come from caller (`"bash-"` is fixed today), but the unguessable part is generated by the OS, not user input |
| `harness/env/nodejs.ts:679-689` (`createTempFile`) | Creates `<tempdir>/<prefix><uuid><suffix>` and touches it empty | `bash` tool output overflow path | UUID from `node:crypto randomUUID()`; parent dir is 0700 from `mkdtemp` | No direct attacker control over the path itself |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `harness/session/jsonl/codec.ts:32-41,65-180` | `JSON.parse` of each session JSONL line, then strict field-by-field validation (`requireString`/`requireSequence`/type-tag switch) before it becomes an `Entry`/`LaneRecord` | loading any session file at startup / resume | Strong: unknown `kind`/`type` values throw `invalidFile`; malformed trailing line triggers torn-tail repair (`storage.ts:82-90`) instead of crashing | Session files are locally trusted app state, but a forked/shared/synced session file is technically T3/T5-adjacent input |
| `harness/skills.ts:1-2,312-326` (`parseFrontmatter` via `yaml.parse`) | Parses YAML frontmatter out of `SKILL.md` files found by walking directories (recursive) | `loadSkills()`, called whenever a host refreshes skills (e.g., at session start or on a slash command) | try/catch → diagnostic, not thrown; result is only ever placed into `Skill.description`/`content` (system-prompt *text*), never executed | **Yes** — `SKILL.md` under a project directory is exactly the kind of repository content T1 describes; a malicious repo can ship one |
| `harness/prompt-templates.ts:1-2,201-215` (`parseFrontmatter` via `yaml.parse`) | Same pattern for `.md` prompt-template files | `loadPromptTemplates()` | same | Yes, same T1 vector |
| `harness/tools/edit.ts:48-56` (`prepareEditArguments`) | `JSON.parse(args.edits)` — the model is allowed to send `edits` as a JSON-encoded string (legacy compatibility) instead of a structured array | every `edit` tool call where the model uses the string form | wrapped in try/catch; falls through to normal validation if parse fails or result isn't an array | Yes — this is parsing the model's own tool-call arguments (T2), but only reshapes them, does not execute anything |
| `proxy.ts:198-207` (`JSON.parse(data)`) | Parses each SSE `data:` line from a proxy server response into a `ProxyAssistantMessageEvent` | only if a host app opts into `streamProxy` as its `streamFn` | none beyond a `switch` on `.type`; an unrecognized `type` falls to a `console.warn` default branch (`processProxyEvent:363-367`) | Only if the configured `proxyUrl` (host-controlled) is itself compromised — not reachable via T1/T2 in strape's current wiring since strape doesn't use `streamProxy` |

### credentials

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `agent-loop.ts:304-312` | Resolves the provider API key via `config.getApiKey(provider)` (host-supplied, e.g. to support short-lived/rotating tokens) or falls back to `config.apiKey`, then passes it into the stream call on every turn | every assistant turn | key resolution itself is host-controlled; this package only threads the value through | No — provider/model come from harness config, not model output |
| `proxy.ts:154-166` | Sends `Authorization: Bearer ${options.authToken}` plus the *entire* `Context` (system prompt + full message history) as JSON to `${proxyUrl}/api/stream` | only when a host explicitly configures `streamProxy` as `streamFn` | none — host owns both `proxyUrl` and `authToken`; no scrubbing of message content before it's serialized and sent | Indirect: if `proxyUrl`/`authToken` were ever derived from untrusted config, the whole transcript (which may contain secrets the model read from files) would go with it. Not used by strape today (OpenAI/xAI direct only per `CLAUDE.md`) |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `harness/env/nodejs.ts:240-251` (`getShellEnv`) | Every `bash` tool invocation inherits **the full parent process environment** (`...process.env`) by default (`inheritEnv` defaults to `true` in `ShellExecOptions`) merged with any harness-level `shellEnv` and per-call `env` overrides | every `bash` tool call | `inheritEnv:false` exists as an opt-out, but nothing in this package sets it — the `bash` tool always passes `execution.inheritEnv = true` (`tools/bash.ts:66`) | This is the key exfiltration surface: if the process env holds `OPENAI_API_KEY`/`XAI_API_KEY`/other secrets, a model-issued `bash` command can read and (if it also has network access via the shell itself) exfiltrate them — see "missed by the sweep" below |
| `harness/env/nodejs.ts:205-208` | Reads `process.env.ProgramFiles` / `ProgramFiles(x86)` to locate Git-Bash on Windows | shell discovery on Windows | fixed variable names, read-only | No |

### trust (all 3 sweep hits are false positives — see below)

No genuine trust/approval-decision code exists in this package; see Dismissed sweep hits.

## Dismissed sweep hits (with reason)

- **`process-exec` — `harness/session/jsonl/repo.ts:67,76`, `harness/session/jsonl/storage.ts:99`,
  `harness/session/memory.ts:33,175,179`, `harness/session/testing/conformance.ts:898-990`,
  `harness/session/types.ts:351`** (21 of 21 non-bash `process-exec` hits): the sweep's `\bfork\s*\(`
  pattern matches `SessionRepo.fork()` / `SessionStorage.fork()` / `InMemorySessionStorage.fork()` — the
  session-tree **branching** API (create a new session log that shares history with an existing one up to a
  point). This has nothing to do with `child_process.fork`. Verified by reading every call site; none touch
  `node:child_process`.
- **`trust` — `harness/env/nodejs.ts:111`, `harness/types.ts:135,260`**: the sweep's `\bpermission\b`
  pattern matches the `FileError` code literal `"permission_denied"` (mapped from Node's `EACCES`/`EPERM`)
  and its doc-comment. This is an OS filesystem error code being surfaced as a typed error, not a
  trust/approval decision.
- **`network` — `harness/env/nodejs.ts:222`**: matches the literal string `https://git-scm.com/download/win`
  inside a static, non-interpolated error message shown when no bash shell can be found on Windows. No
  request is made; it's help text for the human running the CLI.
- **`network` — `proxy.ts:79`**: matches a JSDoc example comment (`"https://genai.example.com"`), not code.
- **`deserialize` — `harness/prompt-templates.ts:1`, `harness/skills.ts:2`**: the sweep's `\byaml\b`
  pattern also matched the bare `import { parse } from "yaml"` lines themselves (in addition to the real
  `parse(...)` call sites already covered above under Capability inventory) — not a second, distinct
  capability site.

## Capabilities found by reading, missed by the sweep

- **Bash gives unrestricted outbound network access that no `network`-class regex will ever find in this
  package.** The sweep only looks for `fetch`/URLs/etc. in TypeScript source. But the `bash` tool
  (`harness/tools/bash.ts`) executes an arbitrary shell command with the full inherited environment
  (`nodejs.ts:240-251`), so `curl`, `wget`, `nc`, DNS exfiltration, etc. are all reachable the moment a
  `bash` tool call is approved (or auto-approved by a host that didn't wire `beforeToolCall`). Combined with
  full-`process.env` inheritance, this is the most direct T4 exfiltration path in the whole package, and it
  is structurally invisible to source-level scanning — it has to be reasoned about, not grepped for.
- **No default approval gate exists in this package at all.** `agent-loop.ts`'s `prepareToolCall` (line
  600-664) calls `config.beforeToolCall` *if the host supplied one* and otherwise runs every tool
  unconditionally. `Agent` (`agent.ts:106-107,185-192`) and `AgentHarnessOptions` likewise make
  `beforeToolCall`/`afterToolCall` optional fields with no default implementation. Every "is this safe to
  run" decision described in the threat model (T1/T2) is therefore delegated wholesale to whatever sits
  outside `packages/agent/src` — worth confirming the host CLI package actually always supplies one, since
  this package will run bash/write/edit with zero confirmation if it doesn't.
- **`write`/`edit` have no workspace jail.** `resolveToolPath` (`harness/tools/path-utils.ts:12-14`) resolves
  any path (including `../../..` traversal or an absolute path like `/etc/cron.d/x`) relative to `env.cwd`
  with no containment check. This mirrors what `bash` can already do, so it's not a new privilege by itself,
  but it means the `write`/`edit` tools cannot be treated as "safer" than `bash` for sandboxing purposes by a
  host that only gates one of them.
- **`assertJsonSerializable` (`harness/session/session.ts:42-100`) is a real, load-bearing prototype-pollution
  and cycle-safety guard** applied to every entry/record before it's queued for persistence — it rejects
  non-plain objects, symbol keys, non-enumerable/accessor properties, sparse/non-standard arrays, `NaN`/
  `Infinity`, and reference cycles. This is not flagged by the sweep (no matching pattern) but is one of the
  stronger defensive controls in the package and directly relevant to "session file written from
  attacker-influenced message content" (T1/T4).
- **Torn-tail repair (`harness/session/jsonl/storage.ts:69-97`)** silently truncates a session file back to
  its last valid line if the final line is malformed JSON (e.g., from a crash mid-write), rather than
  refusing to load or throwing. Good for durability; worth the reviewer noting that a corrupted/truncated
  *earlier* line (not just the tail) is still a hard failure (`SessionError`), so only tail corruption is
  self-healing.
- **`streamProxy` (`proxy.ts`) is exported from the public API surface (`index.ts:141`) but not wired to
  anything by default.** It's dead capability unless a host opts in. Given `CLAUDE.md`'s "OpenAI + xAI,
  direct" scope for strape, confirm no strape-side code (outside this package) actually constructs a
  `streamProxy` — if it doesn't, this whole code path is inert in the shipped product but still ships in the
  bundle.

## Questions for the human reviewer

1. Does the strape CLI package (outside this scope) *always* supply `beforeToolCall`/`afterToolCall`, and
   does it fail closed (deny) if that wiring is ever skipped for a code path (e.g., a non-interactive/CI
   mode)? This package provides no default-deny.
2. Is `bash`'s `inheritEnv: true` default (full `process.env` passthrough, `harness/tools/bash.ts:66`)
   intentional for strape's deployment model, or should the host be scrubbing `OPENAI_API_KEY`/`XAI_API_KEY`
   and any OAuth tokens out of the process environment before the harness process is even started, given
   they're otherwise trivially readable by any model-issued `bash echo $VAR`?
3. Are `SKILL.md` / prompt-template directories ever pointed at repository-controlled paths (e.g., a
   project's own `.claude/skills` or similar checked into the repo the agent is working on) as opposed to
   only user-owned config directories? That determines whether the YAML-frontmatter parsing in
   `harness/skills.ts` / `harness/prompt-templates.ts` is T1-reachable in practice, not just in theory.
4. Is `streamProxy` (`proxy.ts`) actually unreachable from strape's CLI wiring, confirming it's dead code in
   the shipped product? If some path does construct it, its `proxyUrl`/`authToken` provenance needs the same
   scrutiny as the direct-provider API key path.
5. `harness/agent-harness.ts`'s `AgentHarness` class is almost entirely `HarnessNotImplemented` stubs in this
   release — confirm the CLI actually drives the lower-level `Agent` (`agent.ts`) / `agentLoop`
   (`agent-loop.ts`) directly rather than this scaffold, so review effort isn't misallocated to unused code.
