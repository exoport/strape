# Utils

## Scope (files + LOC)

`packages/coding-agent/src/utils/` — 32 files, 3519 LOC (`wc -l`, including the 19-line `.d.ts`).

| file | LOC | role |
|---|---|---|
| abort.ts | 48 | AbortSignal helpers |
| ansi.ts | 60 | strip-ansi (regex only, vendored) |
| changelog.ts | 196 | CHANGELOG.md parsing + link rewriting |
| child-process.ts | 137 | spawn/spawnSync wrappers, exit-drain logic |
| clipboard-image.ts | 300 | clipboard image read (wl-paste/xclip/PowerShell/native) |
| clipboard-native.ts | 33 | loads native `@mariozechner/clipboard` addon |
| clipboard.ts | 175 | clipboard text read/write (native + CLI tools + OSC52) |
| deprecation.ts | 14 | one-shot deprecation warning printer |
| exif-orientation.ts | 183 | manual EXIF/TIFF orientation parser + Photon rotate/flip |
| frontmatter.ts | 39 | YAML frontmatter extraction (`yaml` pkg) |
| fs-watch.ts | 30 | `fs.watch` wrapper with error handler |
| git.ts | 226 | git/hosted-git URL parsing & validation |
| highlight-js-lib-index.d.ts | 19 | type declarations only, no runtime code |
| html.ts | 51 | HTML entity **decoder** (no encoder/escaper here) |
| image-convert.ts | 49 | image → PNG via Photon |
| image-process.ts | 119 | normalize mime type, convert, resize pipeline |
| image-resize-core.ts | 164 | Photon-based resize/encode loop |
| image-resize.ts | 123 | spawns a Worker thread to run resize off the main loop |
| image-resize-worker.ts | 42 | worker_threads entry point for resize |
| json.ts | 6 | strip `//` comments/trailing commas from JSON text |
| management-http.ts | 68 | generic `fetch` + bounded retry helper |
| mime.ts | 116 | magic-byte image type sniffing |
| open-browser.ts | 24 | spawn OS "open URL" command |
| paths.ts | 139 | path normalize/resolve/realpath, cloud-sync xattr tagging |
| photon.ts | 139 | lazy dynamic `import()` of Photon WASM image lib, `fs.readFileSync` monkey-patch |
| pi-user-agent.ts | 4 | User-Agent string builder |
| shell.ts | 225 | resolves bash executable, builds shell env, kills process trees |
| sleep.ts | 18 | abortable `setTimeout` |
| syntax-highlight.ts | 146 | highlight.js wrapper + custom HTML→ANSI-ish renderer |
| tool-result-images.ts | 62 | routes tool-produced images through image-process |
| tools-manager.ts | 371 | **downloads, extracts, installs fd/rg binaries from GitHub** |
| version-check.ts | 109 | checks pi.dev for a newer CLI version |
| windows-self-update.ts | 84 | quarantines/replaces loaded native `.node` files on Windows |

## What this area can do (prose)

`utils/` is the harness's low-level toolbox: it resolves and spawns the shell the `bash` tool uses, spawns and reaps arbitrary child processes on the host (git tools, clipboard helpers, browser openers, archive extractors), reads and writes the OS clipboard through five different code paths depending on platform/session (native addon, `wl-paste`/`wl-copy`, `xclip`/`xsel`, `pbcopy`/`clip`, PowerShell, or OSC-52 escape sequences), and decodes/transcodes/resizes images (including ones that arrive as base64 blobs from arbitrary tool/extension/MCP output) through a Photon (Rust→WASM) library that is lazily `import()`-ed and whose `fs.readFileSync` the module temporarily monkey-patches process-wide. Its most consequential capability is `tools-manager.ts`, which the built-in `grep`/`find` tools call automatically (silently, `silent=true`) the first time the model invokes them: it hits the public GitHub API, downloads a versioned `ripgrep`/`fd` release archive, extracts it with `tar`/`unzip`/`bsdtar`/PowerShell, `chmod +x`'s it, and runs it — with no checksum, signature, or pinned-version verification of any kind. Everything else in the folder is comparatively low-risk plumbing: path normalization/realpath resolution, JSON-with-comments stripping, YAML frontmatter parsing for skill/prompt-template/CLAUDE.md-like files, a `git:`/`https://` URL parser used by the package manager to gate what can be installed, a version-check client that respects `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`, and Windows-specific native-module quarantining used during self-update.

## Capability inventory

### process-exec

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| shell.ts:67-120 `getShellConfig` | Resolves which shell binary (`/bin/bash`, Git Bash, user `shellPath`, or PATH `bash`/`which`) backs every `bash` tool call | Every `bash` tool invocation (model-triggered) | `existsSync` check on custom path; throws if a user-specified path doesn't exist | `customShellPath` comes from `settingsManager.getShellPath()` (see "Questions" — depends whether project-level settings can set this) |
| shell.ts:24-58 `findBashOnPath` | `spawnSync("where"/"which", ...)` to locate bash | Called during shell resolution (startup / first bash call) | fixed argv, 5s timeout | no |
| shell.ts:200-225 `killProcessTree` | `spawn("taskkill", ...)` / `process.kill(-pid, "SIGKILL")` to kill a process group | Tool timeout / abort / shutdown (SIGHUP/SIGTERM) of a detached child | pid comes from harness's own tracked child list | no (pid is internal) |
| child-process.ts:18-36 `spawnProcess`/`spawnProcessSync` | Thin wrapper around `child_process.spawn(Sync)` / `cross-spawn` on Windows | Called throughout the codebase (git ops, bash tool, path xattr tagging, tools-manager) whenever a subprocess is needed | none itself — policy enforced by callers | depends entirely on caller |
| clipboard.ts:14,16,45,107,110,116,130,135 | `execSync`/`execFileSync`/`spawn` of `xclip`, `xsel`, `wl-paste`, `pbcopy`, `clip`, `termux-clipboard-set`, `wl-copy` | User paste/copy actions in the TUI (Ctrl+V / copy commands) | fixed command strings; user data passed via stdin, never interpolated into the command string | no (commands fixed; payload via stdin) |
| clipboard-image.ts:97 `runCommand`/`spawnSync` | Runs `wl-paste`, `xclip`, `wslpath`, `powershell.exe` to read clipboard images | User paste-image action | fixed argv arrays, timeouts (1-5s), bounded `maxBuffer` | no |
| open-browser.ts:21 `spawn(cmd, args, {...})` | Opens a URL/file with `open`/`rundll32`/`xdg-open`, **no shell** | Only caller found: OAuth `login-dialog.ts` `showAuth(url)` | comment explicitly notes avoiding `cmd /c start` to prevent metacharacter injection on Windows; argv-based, not shell string | `target` is the OAuth provider's own auth URL, not directly repo/model controlled in the one call site found |
| tools-manager.ts:77 `commandExists`/spawnSync | Probes `cmd --version` to check if fd/rg/tar/unzip exist | `getToolPath()` called by `grep`/`find` tools on every invocation until a tool is resolved | none needed (probe only) | no |
| tools-manager.ts:178-240 `runExtractionCommand`/`extractTarGzArchive`/`extractZipArchive` | Shells out to `tar`, `unzip`, `bsdtar` (Windows `tar.exe`), or PowerShell `Expand-Archive` to unpack downloaded fd/rg archives | Automatically inside `downloadTool()` (see network table) | archive path/dest are internally constructed; PowerShell script uses `param()` binding, not string interpolation | archive contents originate from GitHub release assets (see network row) |

### network

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| tools-manager.ts:108-123 `getLatestVersion` | `fetch` to `https://api.github.com/repos/${repo}/releases/latest` | Automatic, inside `ensureTool()`, first time `grep`/`find` tool runs and rg/fd aren't already present | none (no pinning to a known-good version) | repo name is a hardcoded constant (`sharkdp/fd`, `BurntSushi/ripgrep`); response controls which binary version gets installed |
| tools-manager.ts:126-139,265-271 `downloadFile`/`downloadTool` | Downloads the release archive over HTTPS and streams it to disk via `createWriteStream` | Same trigger as above | HTTPS only; **no checksum/signature verification of the downloaded binary** | yes in the sense that a compromised GitHub release, DNS/TLS interception, or hijacked upstream repo would result in this code executing an attacker's binary later (see fs-write/process-exec rows) |
| management-http.ts:25-68 `fetchWithRetry` | Generic `fetch` wrapper with timeout + bounded retry on transient errors/status codes | Used by version-check.ts and tools-manager.ts | caller supplies URL; this file does no URL validation itself | depends on caller |
| version-check.ts:5,51-88 `getLatestPiRelease` | `fetch` to fixed `https://pi.dev/api/latest-version` | Startup / explicit version check, gated by `PI_OFFLINE` | `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK` env vars short-circuit it; response fields are type-checked before use | no (URL fixed, response only informs a version string shown to the user) |

### fs-write

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| clipboard-image.ts:162,196-210 | Writes a WSL clipboard screenshot to `join(tmpdir(), "pi-wsl-clip-<randomUUID>.png")`, reads it back, `unlinkSync`s it in a `finally` | User paste-image action on WSL | filename uses `randomUUID()`, not PID/time — **not** a predictable-temp-path pattern (contrast CVE-2026-54328) | no |
| tools-manager.ts:137,263,279,302,309,313,314 | `createWriteStream` (download), `mkdirSync` (tools dir + unique extract dir), `renameSync` (install binary), `chmodSync(0o755)`, `rmSync` (cleanup archive + extract dir) | Automatic inside `downloadTool()` | extract dir name includes `pid_timestamp_random` to avoid concurrent-download races; all paths under per-user `getBinDir()` (`~/.pi/agent/bin` equivalent), not shared `/tmp` | destination paths are internally derived; **content** written is the unverified downloaded binary |
| windows-self-update.ts:56,80-82 | `rmSync` quarantine dir, `mkdirSync`, `renameSync` a loaded native `.node` file into quarantine, `copyFileSync` a fresh copy back into place | `pi` startup (win32 only) and package-manager CLI update flow | quarantine dir lives under the package's own `node_modules`, not a world-writable temp dir | no (packageDir is the install path, not attacker data) |

### env

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| clipboard-image.ts:22,143,258 | `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`, `WSL_DISTRO_NAME`/`WSLENV`, generic `env` param | Environment/session detection for clipboard strategy | none needed (read-only detection) | no |
| clipboard.ts:22,54,114,124,125 | `SSH_CONNECTION`/`SSH_CLIENT`/`MOSH_CONNECTION`, `TERMUX_VERSION`, `WAYLAND_DISPLAY`, `DISPLAY` | Same, for clipboard write strategy | n/a | no |
| clipboard-native.ts:16,31 | `process.env.DISPLAY`/`WAYLAND_DISPLAY`, `TERMUX_VERSION` gate whether the native clipboard addon is loaded at all | Module load time (process startup) | n/a | no |
| shell.ts:79,83,124-131 | `ProgramFiles`, `ProgramFiles(x86)` (Windows Git Bash lookup); rebuilds `PATH` to prepend `getBinDir()` (`getShellEnv`) | Shell resolution / every bash tool invocation | n/a | `getShellEnv()` means the fd/rg binaries silently downloaded by tools-manager.ts are also on `PATH` for every `bash` tool command |
| tools-manager.ts:16,194 | `PI_OFFLINE` (skips auto-download), `SystemRoot`/`WINDIR` (locate `tar.exe`) | n/a | `PI_OFFLINE` is the only opt-out for the auto-download behavior | no |
| version-check.ts:55,98 | `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK` | n/a | these are the only guards on outbound version-check network calls | no |

### dynamic-code (mostly false positives — see Dismissed section)

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| photon.ts:116-138 `loadPhoton` | Lazily `await import("@silvia-odwyer/photon-node")` (fixed literal specifier) and, while loading, **temporarily monkey-patches the global `fs.readFileSync`** to redirect the WASM file read to a fallback path (needed for Bun single-binary builds) | First call that needs image processing (image read, paste, resize) | module specifier is a fixed string; patch is restored in `finally` | no attacker control over *what* is loaded; the monkey-patch is a process-wide, non-reentrant mutation of a built-in — see "Questions" for reentrancy concerns |
| clipboard-native.ts:14-23 `loadClipboardNative` | `createRequire(...)` then `require("@mariozechner/clipboard")` from two resolution roots | Process startup (module load), gated by platform/display checks | fixed literal package name | no |

### deserialize

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| frontmatter.ts:1,28-37 `parseFrontmatter` | `yaml` package `parse()` of the YAML block between `---` fences | Called by `skills.ts`, `prompt-templates.ts`, `agent-session.ts` (per `grep` of callers) when reading SKILL.md-like files, prompt templates, and session-adjacent files | none beyond the `yaml` library's own defaults (e.g. its built-in alias-count limit against billion-laughs); no schema/size limit imposed here | **yes** — this is exactly the T1 surface: a malicious repo's skill/prompt-template file content is parsed as YAML by this function |

### temp-paths

| file:line | what | trigger | guard | attacker-influenced? |
|---|---|---|---|---|
| clipboard-image.ts:162 | `join(tmpdir(), \`pi-wsl-clip-${randomUUID()}.png\`)` | WSL clipboard-image paste | `randomUUID()` makes the name unpredictable, unlike a PID/timestamp-only name — this is the *good* pattern, not a CVE-2026-54328 sibling | no |

## Dismissed sweep hits (with reason)

- `syntax-highlight.ts:18` (`process-exec`) — the regex sweep matched `.exec(tag)`, which is `RegExp.prototype.exec`, not `child_process.exec`. Pure string/regex logic, no subprocess.
- `exif-orientation.ts:3` (`dynamic-code`) — `type Photon = typeof import("@silvia-odwyer/photon-node")` is a TypeScript **type-only** import, erased at compile time; no runtime `import()` occurs on this line.
- `photon.ts:21` (`dynamic-code`) — `createRequire(import.meta.url)` just builds a `require` function; no code execution yet.
- `photon.ts:22` (`dynamic-code`) — `require("fs")` loads Node's built-in `fs` module with a fixed literal; not attacker-reachable.
- `photon.ts:32,33,116` (`dynamic-code`) — all three are TypeScript type positions (`typeof import(...)` in a variable type annotation / function return type), not executed dynamic imports. The one real dynamic import is line 128, already covered above.
- `changelog.ts:70,71,97` (`network`) — these are template-string constants used to **rewrite markdown link text** (`https://github.com/${GITHUB_REPO}/...`) for display; no `fetch`/`http` call happens in this file at all. Sweep matched the literal `https://` substring, not a network capability.
- `shell.ts:102` (`network`) — `https://git-scm.com/download/win` is plain text inside a thrown `Error` message shown to the user when no bash is found; not a network call.
- `clipboard-native.ts:14,15` (`dynamic-code`, already listed above) — infra only, module specifier fixed.
- `clipboard-image.ts:22,143,258` and `clipboard.ts:22,54,114,124,125` (`env`) — legitimate but non-sensitive: these are all feature-detection reads (`WAYLAND_DISPLAY`, `DISPLAY`, `TERMUX_VERSION`, `SSH_*`), not credential/secret env vars. Listed in the env table above rather than dismissed, but noting explicitly they carry no confidentiality concern.

## Capabilities found by reading, missed by the sweep

- **Automatic, unverified binary download+execution triggered by ordinary tool use.** The sweep tagged the individual `fetch`/`spawnSync`/`fs` primitives in `tools-manager.ts` but nothing ties them together as one capability: calling the built-in `grep` or `find` tool (`src/core/tools/grep.ts:172`, `src/core/tools/find.ts:220`) — a normal, usually auto-approved read-only tool call from the model — can silently (`silent=true`, no console output) reach out to `api.github.com`, download a `ripgrep`/`fd` release archive, extract it with system `tar`/`unzip`/PowerShell, `chmod +x` it, and leave it on `PATH` for every subsequent `bash` tool call, all with **zero checksum/signature verification**. This is the single highest-impact finding in this area and is a sibling in spirit to CVE-2026-54325 (component loading without approval) even though it is not extension loading per se.
- **`getShellEnv()` prepends the pi bin dir to `PATH`** (`shell.ts:122-134`), so any binary tools-manager.ts downloads becomes reachable by name from every `bash` tool invocation, not just from the `grep`/`find` tools that triggered the download.
- **Process-wide monkey-patch of `fs.readFileSync`** during Photon WASM loading (`photon.ts:54-110`). This is global mutable state, restored via `finally`, but if two callers raced to trigger `loadPhoton()` concurrently before the `loadPromise` memoization takes effect, or if any other code calls `fs.readFileSync` while the patch is installed and throws an `ENOENT` for an unrelated `photon_rs_bg.wasm`-suffixed path, it would silently substitute an unexpected file. Low likelihood, but it's a global side effect that a simple sweep can't see because it's runtime behavior, not text.
- **`index.ts` re-exports `copyToClipboard`** (`src/index.ts:402`) as part of the public library surface — not model/tool-facing today (no tool wraps it), but any host embedding the `coding-agent` package as a library gets clipboard-write capability for free.
- **`git.ts`'s `parseGitUrl` is a security-relevant validator**, not just a parser: `hasUnsafeGitInstallPart` explicitly rejects `\0`, backslashes, leading `/`, and `..` path segments. It's called from `package-manager.ts:1438` and `interactive-mode.ts:590,1300` to decide what git sources may be installed as packages/skills — worth cross-referencing against the package-manager area's own capability map since the actual install/clone step lives outside `utils/`.
- **Worker-thread spawn for image resize** (`image-resize.ts:21-23`, `Worker(workerSpecifier)`) isn't `process-exec` (same-process thread, not a subprocess) and wasn't flagged by the sweep, but it is a form of code loading — the specifier is a fixed relative path (`./image-resize-worker.ts/.js`, or a hardcoded Bun-specific string path), not attacker-influenced.

## Questions for the human reviewer

1. **Is `settingsManager.getShellPath()` (consumed by `shell.ts:67-73` `getShellConfig`) sourced only from global (`~/.pi/settings.json`-equivalent) settings, or can a project-level/workspace `.pi/settings.json` (i.e., repo content under T1) also set `shellPath`?** If project settings can set it without a trust prompt, a malicious repo could redirect every `bash` tool call to an attacker-controlled "shell" binary. This crosses into `core/settings-manager.ts`, outside this section's scope, but the trust boundary is enforced (or not) at the `utils/shell.ts:67-74` call site.
2. **Should `tools-manager.ts`'s `downloadTool()` pin/verify a checksum or minimum/maximum version for fd/rg**, given it runs automatically and silently off of a normal `grep`/`find` tool call? Right now it trusts whatever `api.github.com/repos/.../releases/latest` and the corresponding download URL return, with no hash pinning.
3. Is the `yaml` package version used by `frontmatter.ts` configured with any `maxAliasCount`/depth limits beyond its own defaults, given it parses attacker-influenceable skill/prompt-template content (T1)? Worth confirming against the dependency-closure review (Job B).
4. `windows-self-update.ts` and the fd/rg install path both write into locations derived from the package's own install directory / `getBinDir()`, not a world-writable OS temp dir — worth having the "core/config" reviewer confirm `getAgentDir()`/`getBinDir()` are always per-user (e.g., under `homedir()`), since `utils/` merely joins onto whatever `config.ts` returns.
