# Built-in tools

## Scope (files + LOC)

`packages/coding-agent/src/core/tools/` — 15 files, 4110 LOC total.

| file | LOC | role |
|---|---|---|
| `bash.ts` | 505 | `bash` tool — arbitrary shell execution |
| `edit-diff.ts` | 560 | text-diff/fuzzy-match engine used by `edit` |
| `edit.ts` | 437 | `edit` tool — exact-text-replacement file editing |
| `find.ts` | 375 | `find` tool — glob file search (shells out to `fd`) |
| `file-mutation-queue.ts` | 61 | per-file write serialization |
| `grep.ts` | 385 | `grep` tool — content search (shells out to `rg`) |
| `index.ts` | 196 | tool registry / factory (`read,bash,edit,write,grep,find,ls`) |
| `ls.ts` | 225 | `ls` tool — directory listing |
| `output-accumulator.ts` | 222 | streaming output buffer, spills to OS temp dir |
| `path-utils.ts` | 118 | path resolution (`~`, macOS unicode variants) — no jail |
| `read.ts` | 351 | `read` tool — text/image file reading |
| `render-utils.ts` | 85 | TUI rendering helpers (path shortening, output extraction) |
| `tool-definition-wrapper.ts` | 47 | adapts `ToolDefinition` → `AgentTool` |
| `truncate.ts` | 276 | shared line/byte truncation logic (2000 lines / 50KB) |
| `write.ts` | 267 | `write` tool — full file create/overwrite |

There is no separate `glob.ts` or `todo.ts` in this directory: glob search is `find.ts`, and there is no built-in todo-list tool in this package. `git diff v0.84.0..main --stat` shows **none** of the 6 strape hunks touch this directory — everything here is unmodified upstream v0.84.0 code.

## What this area can do (prose)

This directory implements the seven tools an LLM tool-call can invoke directly: `bash` (spawn any shell command via `child_process.spawn`, unsandboxed, with the full process environment plus `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL` injected by default), `read`/`write`/`edit` (arbitrary filesystem read/create/overwrite/patch, with path resolution that honors `~` and absolute paths but performs **no containment to the workspace root** — any path the OS-level user can reach is fair game), and `grep`/`find`/`ls` (read-only search and listing that shell out to bundled `ripgrep`/`fd` binaries). None of these tools implement their own approval/confirmation gate — every `execute()` in this directory runs to completion as soon as it is called; whatever consent flow exists (permission prompts, sandbox policy) lives in `modes/interactive/` or `core/extensions/`, outside this directory's scope, so this section cannot itself confirm a human is asked before `bash`/`write`/`edit` fire. Two indirections meaningfully extend "what this area can do" beyond what's visible on the surface: `grep`/`find` transparently and silently download prebuilt `rg`/`fd` binaries from GitHub over HTTPS (no checksum/signature check) the first time they're needed, and `bash`'s streamed output over the truncation threshold is spilled to a file in the shared OS temp directory that is never deleted and inherits default (world-readable) permissions.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `bash.ts:97` (`createLocalBashOperations`) | `child_process.spawn(shell, [...args, command])` — runs the model-supplied string in a real shell (bash/zsh/sh/cmd), inherits full env (`getShellEnv()` = `{...process.env}` + PATH prepend), detached process group, killable tree, optional timeout | Model emits a `bash` tool call | None in this file: no allow/deny list, no sandbox, no path/command restriction. Any approval gate is external (not in this dir) | **Yes — directly.** `command` is the raw string from the tool call; if the model's output is attacker-steered (T2) or the model is following injected instructions from repo content (T1), this is unrestricted code execution with the harness process's privileges |
| `bash.ts:429` | `ops.exec(spawnContext.command, spawnContext.cwd, {...})` — the tool's call site into the operation above (or a caller-supplied override, e.g. SSH backend) | Same as above | Same as above | Same |
| `grep.ts:221` | `spawn(rgPath, args, {stdio:[...]})` — runs `ripgrep` with `pattern`, `glob`, `path` derived from tool-call args | Model emits a `grep` tool call | Args are passed as an argv array (not through a shell), so no shell-metacharacter injection; `pattern`/`glob` reach `rg` as literal argv values | Args influenced by model output, but `rg` itself is a fixed, non-shell search binary — no command injection, only search-pattern/DoS-style influence (e.g. expensive regex) |
| `find.ts:264` | `spawn(fdPath, args, {stdio:[...]})` — runs `fd` with pattern/path from tool-call args | Model emits a `find` tool call | Same argv-array pattern as grep | Same as grep — no injection, bounded to search |
| `bash.ts:5`, `find.ts:4`, `grep.ts:5` | `import { spawn } from "child_process"` | n/a (import) | n/a | Sweep false-positive as a "site" — just the import statement, real risk is at the call sites above |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `write.ts:214,218` | `ops.mkdir(dir)` then `ops.writeFile(absolutePath, content)` — creates parent dirs and (over)writes a file with model-supplied content at a model-supplied path | Model emits a `write` tool call | `resolveToCwd()` only resolves `~`/relative paths against `cwd`; **does not confine the result to `cwd`** (see path-utils finding below). `withFileMutationQueue` only serializes concurrent writes to the same file, it is not a security guard | **Yes.** Path and content both come from the tool call; a model instructed by injected repo content (T1) or acting maliciously (T2) can overwrite any file writable by the OS user, e.g. shell profiles, SSH `authorized_keys`, cron files, CI config |
| `edit.ts:347` | `ops.writeFile(absolutePath, finalContent)` — writes the patched file after applying `edits[]` to the original content | Model emits an `edit` tool call | Requires the target file to already exist and be read/write-accessible (`ops.access`); otherwise same lack of path confinement as `write` | Same as write, but limited to modifying existing files via matched-text replacement rather than arbitrary new content |
| `output-accumulator.ts:216` | `createWriteStream(this.tempFilePath)` — opens the temp file used to persist truncated `bash` output | Automatic once a bash command's output exceeds 2000 lines / 50KB | None (default `fs` mode ⇒ 0644 typically); file is never unlinked by this code | Indirectly attacker-influenced: content is whatever the executed command printed, which can include secrets the command read (e.g., `cat .env`, `env`) |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `edit.ts:104` | `JSON.parse(args.edits)` — fallback when a model sends `edits` as a JSON-encoded string instead of an array (comment cites "Opus 4.6, GLM-5.1") | Model tool-call argument shape | Wrapped in `try/catch`; result only used if `Array.isArray(parsed)`, else silently ignored | Model-controlled string, but parsed result only feeds into `oldText`/`newText` string fields consumed by a text-diff matcher — no prototype-pollution or code-exec path observed |
| `grep.ts:276` | `event = JSON.parse(line)` — parses one JSON-lines record from ripgrep's `--json` stdout | Automatic while streaming `rg` output | `try/catch`, unparseable lines are skipped | Line content originates from files in the repo being searched (T1: file content is attacker-controlled), but it's JSON produced by `rg` itself (properly escaped), then only `event.data.path.text` / `line_number` / `lines.text` fields are read as strings — no eval, no prototype pollution demonstrated |

### temp-paths

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| `output-accumulator.ts:21` | `join(tmpdir(), \`${prefix}-${id}.log\`)` where `id = randomBytes(8).toString("hex")` (64 bits) | Automatic once bash/tool output needs spilling to disk | Filename uses a CSPRNG, **not** predictable/sequential — this specific pattern does *not* reproduce the "predictable temp path" CVE (CVE-2026-54328) shape | Not attacker-chosen, but see finding below: the file is created with default permissions and never deleted, so on a shared multi-user box (T3) another local user who can `ls /tmp` can read command output (T4) even though they can't predict/plant the filename in advance |

## Dismissed sweep hits (with reason)

- `bash.ts:5`, `find.ts:4`, `grep.ts:5` (`import { spawn } from "child_process"`) — these are the plain import lines the sweep's regex matches; the real capability sites are the actual `spawn(...)` calls listed above (`bash.ts:97`, `grep.ts:221`, `find.ts:264`), which are already inventoried. Not a separate capability.
- No other sweep hits in this directory look like false positives — all 14 hits map to a real, described capability. (`bash.ts:429` is a second, legitimate reference to the same `exec` capability as `bash.ts:97`, not a duplicate/FP — it's the call site vs. the implementation.)

## Capabilities found by reading, missed by the sweep

- **Silent network download + unsigned binary execution (T5).** `grep.ts:172` (`ensureTool("rg", true)`) and `find.ts:220` (`ensureTool("fd", true)`) call into `packages/coding-agent/src/utils/tools-manager.ts` (outside this directory, so its own `network`/`process-exec`/`fs-write` sweep hits at lines 110/179/265/etc. don't show up when filtering the sweep to `core/tools/`). If `rg`/`fd` are not already present locally or on `PATH`, this code downloads a release tarball/zip from `https://github.com/<repo>/releases/download/...` , extracts it with `tar`/`unzip`/PowerShell, `chmod 755`s the result, and then immediately `spawn`s it — all with **no checksum or signature verification** and with the `silent=true` flag suppressing even the console notice to the user. This is a real-time, unapproved third-party binary install-and-run chain triggered by a completely ordinary `grep`/`find` tool call, and is the closest sibling in this area to the "extension loading without user approval" CVE-2026-54325 pattern (same shape: fetch code from the network and execute it without a consent gate), just for search tools instead of the extension system. It resolves to a per-user directory (`getBinDir()` → `~/.<agent>/bin`, not a shared `/tmp`), so it does **not** reproduce CVE-2026-54328's shared/predictable-temp-path privesc shape, and the extraction directory name does include pid+timestamp+random suffix (mitigating the classic tmp race) — but the lack of artifact integrity checking is still worth a reviewer's attention.
- **Full process environment (and session identifiers) handed to every bash command.** `bash.ts:100/165` uses `getShellEnv()` (`utils/shell.ts`, outside this dir) which spreads `{...process.env}` verbatim (plus a `PATH` that prepends the managed bin dir) into every spawned command, and `resolveSpawnContext` (`bash.ts:158-184`) additionally injects `PI_SESSION_ID`, `PI_SESSION_FILE` (a filesystem path to the session transcript), `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` by default (`exposeSessionEnvironment` defaults to `true`). Any secret the harness process holds in its own environment (provider API keys set via env var, CI tokens, etc.) is therefore directly readable by whatever shell command the model decides to run — expected/necessary for a shell tool, but it means prompt-injection-driven bash commands (T1→T2) have a one-`env`-away path to credential exfiltration, and now also have a ready-made pointer (`$PI_SESSION_FILE`) to the full conversation transcript on disk.
- **No path confinement anywhere in `read`/`write`/`edit`/`grep`/`find`/`ls`.** `path-utils.ts:48` (`resolveToCwd`) and the underlying `resolvePath`/`normalizePath` in `../../utils/paths.ts` happily resolve `../../../etc/passwd`, absolute paths, and `~`-paths with no check that the result stays under `cwd`. This isn't flagged by the sweep at all (it's not a spawn/write/network call, just an absence of a check), but it's the root reason every fs-touching tool in this directory can act anywhere the OS user can — reviewers evaluating "workspace escape" should treat this as the load-bearing (non-)control for T1/T2 rather than looking for a missing check inside `write.ts`/`edit.ts` themselves.
- **Bash temp-output file is never cleaned up and uses default permissions.** Already listed under temp-paths above; grepping this directory for `unlink`/`rmSync`/`chmod` on the temp-file path returns nothing, and `createWriteStream` in `output-accumulator.ts:216` doesn't pass a restrictive `mode`. Combined with `tmpdir()` typically being world-listable on Linux, this is a plausible T3/T4 finding a sweep regex (which only looks for the write/temp-path calls, not for the *absence* of cleanup/permission hardening) cannot surface on its own.

## Questions for the human reviewer

1. Is there an approval/confirmation layer (outside `core/tools/`, e.g. in `modes/interactive/interactive-mode.ts` or `core/extensions/`) that gates `bash`/`write`/`edit` execution before `execute()` in this directory runs? This directory has zero such gate itself — every tool call here executes immediately and unconditionally once dispatched.
2. Is the lack of workspace-root confinement in `path-utils.ts`/`utils/paths.ts` (any absolute or `..`-relative path is honored) an intentional design choice (matching upstream pi, which is meant to be a general dev-machine agent) or should it be treated as a gap versus harnesses that jail file tools to the project root?
3. Should `ensureTool()`'s silent GitHub-release download-and-execute path (reachable from ordinary `grep`/`find` calls) require the same user-approval/audit treatment as extension loading, given its similarity to CVE-2026-54325's shape? Should downloaded `rg`/`fd` artifacts be checksum/signature-verified?
4. Should the `bash` tool's overflow-output temp file (`output-accumulator.ts`) be created with `0600` permissions and/or unlinked after the tool result (and any referencing UI) no longer needs it, given it can contain command output with secrets and currently persists indefinitely in the shared OS temp directory?
5. Is `exposeSessionEnvironment` (default `true`, injecting `PI_SESSION_FILE` etc. into every bash command's env) considered acceptable given it hands attacker-influenced shell commands a direct pointer to the full session transcript?
