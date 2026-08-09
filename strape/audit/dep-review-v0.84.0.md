# Dependency review — strape @ upstream pin v0.84.0

Scope: the **50 external npm packages** in strape's shipped closure
(`packages/coding-agent/npm-shrinkwrap.json`, excluding internal `@earendil-works/pi-*` workspace
packages, which are covered by the first-party source audit).

Machine-readable verdicts: `strape/audit/reviewed-deps.json`.
Gate: `node strape/scripts/reviewed-deps.mjs` — fails the build unless every shipped package has a
matching integrity hash and verdict `allow`.

Status: **agent review complete, human sign-off pending.** 23 `allow`, 27 `escalate`.
`reviewedBy` / `reviewedAt` are `null` on every entry by design. The gate is currently FAILING and that
is the intended state.

---

## Method

**The installed tarball was reviewed, not the upstream repository.** Every finding below cites a path
under `<repo>/node_modules/<name>/`. Reading GitHub instead of `node_modules`
would not be a review at all: repo-vs-published-tarball divergence is itself a classic supply-chain
attack, so the file that executes is the only file worth reading. Where provenance mattered, reviewers
closed the loop mechanically — `npm pack` the version fresh, recompute its sha512, compare against the
lockfile's `integrity` field, then `diff -r` the extracted tarball against `node_modules`. That was done
for undici, jiti, cross-spawn and grok-mermaid (all byte-identical, all hashes matching).

**Threat model.** A developer runs strape on a workstation with live provider API keys and full repo
write access, unsandboxed. Every package is judged on what it could do *if* it were malicious or
compromised, and on how visible that would be. "It's popular" is not a control.

**Tiering.**

| Tier | Rule | Depth |
|---|---|---|
| **A** | High consequence or capability-bearing: touches the network, executes code, spawns processes, writes files, or holds locks on auth state. | Read in depth: entry points, every reached file, full-tree capability greps, provenance verified. 12 packages. |
| **B** | Small, single-purpose utilities with a narrow, checkable claim. | Read in full or near-full (most are under 300 lines), plus capability greps. 25 packages. |
| **C** | Cannot be reviewed exhaustively — too large, or not source at all. | Boundary stated explicitly rather than papered over. 13 packages (openai SDK, one WASM blob, `@mariozechner/clipboard` + its 10 prebuilt native sidecars). |

**Adversarial second pass.** The four highest-consequence packages — **undici** (every byte of every LLM
request crosses it), **jiti** (`vm.runInThisContext` on repo-supplied TypeScript), **cross-spawn**
(process execution), **grok-mermaid** (a two-week-old package with a single maintainer) — got a second,
independent pass whose explicit job was to *falsify* the first verdict: re-derive the load-bearing claims
from the files, not from the prose. Results are recorded honestly below. On jiti the second pass
**contradicted** the first and the record was corrected. On undici it **escalated** a concern the first
pass had filed as informational, by proving the code path is live. On cross-spawn it could not falsify
anything and says so. That is the pass working as intended in both directions.

**Models.** The review passes were run by Claude Opus 5 agents (`claude-opus-5[1m]`) working directly
against the installed tree with shell, grep, and — where a claim was cheap to settle empirically —
actually executing the shipped code (grok-mermaid's entity bug was reproduced by running `dist/index.js`;
cross-spawn's ReDoS fix was fuzzed to 200k chars; jiti's cache directory was observed landing in
`/tmp/jiti`; jiti's and undici's embedded binaries were decoded and hashed against upstream). This
synthesis was written by the same model family from those passes' output.

**Lifecycle scripts.** The shipped install-time closure is at **ZERO**. No package in the closure has
`preinstall`, `install` or `postinstall`. Four packages ship a `prepare`/`prepublish`/`prepack` entry
(undici, glob, jiti, get-east-asian-width, which) — npm does not run these for a registry-tarball
dependency, and in undici's and glob's cases the referenced files are not even in the tarball. Each is
recorded in `reviewed-deps.json` so a future grep-based gate does not rediscover them as a surprise.

---

## Reviewed packages

`readable` = what the shipped artifact actually is. Capabilities are the summary; the per-package
`capabilities` array in `reviewed-deps.json` carries file:line citations.

| Package | Tier | readable | Capabilities (summary) | Verdict |
|---|---|---|---|---|
| undici@8.9.0 | A | source | net/tls sockets, WASM llhttp parser, http2, proxy env, globalThis fetch install, dormant fs writes | escalate |
| jiti@2.7.0 | A | partially-minified | `vm.runInThisContext` code execution, dynamic require/import, fs cache writes to /tmp, bundled babel | escalate |
| grok-mermaid@0.2.2 | A | source | pure string computation, zero deps, zero builtins | escalate |
| cross-spawn@7.0.6 | A | source | `child_process.spawn/spawnSync`, 150-byte fs read, `process.chdir`, PATH/COMSPEC env | escalate |
| proper-lockfile@4.1.2 | A | source | fs mkdir/rmdir/utimes, process-exit hook, timer heartbeat | escalate |
| http-proxy-agent@7.0.2 | A | source | net/tls to a caller-supplied proxy, Basic proxy-auth header, ClientRequest mutation | escalate |
| https-proxy-agent@7.0.6 | A | source | net/tls CONNECT tunnel, TLS upgrade with correct SNI, fake-socket leak guard | allow |
| glob@13.0.6 | A | source (min. entry) | fs read traversal, absolute-pattern root escape by design, `follow` off by default | escalate |
| path-scurry@2.0.2 | A | source | fs lstat/readdir/readlink/realpath + LRU caches | escalate |
| yaml@2.9.0 | A | source | pure parse/stringify; bin `--visit` does dynamic `import()` (dead) | escalate |
| marked@18.0.5 | A | source | pure markdown tokenizer; raw HTML passthrough, no URL scheme filtering; CLI spawns `man` (dead) | escalate |
| hosted-git-info@9.0.3 | A | source | git-URL string parsing, bounded LRU; builds URL strings, never fetches | allow |
| chalk@5.6.2 | B | source | color-support env/tty reads only | allow |
| debug@4.4.3 | B | source | `/^debug_/i` env reads, DEBUG read/write on explicit enable, stderr writes | allow |
| ms@2.1.3 | B | source | none (regex + arithmetic) | allow |
| signal-exit@3.0.7 | B | source | patches `process.emit`/`process.reallyExit`, signal handlers, `process.kill` re-raise | escalate |
| semver@7.8.0 | B | source | version parsing; NODE_DEBUG read; CLI unused | allow |
| diff@8.0.4 | B | source | in-memory diff/patch only | allow |
| ignore@7.0.5 | B | source | gitignore→regex matching only | allow |
| get-east-asian-width@1.6.0 | B | source | static Unicode table lookup | allow |
| minimatch@10.2.5 | B | source | glob→RegExp compilation; one test-only env read | allow |
| brace-expansion@5.0.9 | B | source | brace expansion with explicit DoS caps (CVE-2026-14257) | allow |
| balanced-match@4.0.4 | B | source | balanced-substring matching | allow |
| minipass@7.1.3 | B | source | in-memory stream (events/string_decoder only) | allow |
| lru-cache@11.4.0 | B | minified entry | pure in-memory cache; `fetch` is its own refresh API, not network | escalate |
| graceful-fs@4.2.11 | B | source | fs write wrappers, patches `fs.close` + `process.cwd/chdir` process-wide | allow |
| isexe@2.0.0 | B | source | `fs.stat` only | allow |
| which@2.0.2 | B | source | PATH/PATHEXT env reads, fs stat via isexe, declares a bin; never spawns | escalate |
| path-key@3.1.1 | B | source | env read to find the PATH key name | allow |
| shebang-command@2.0.0 | B | source | string parsing only | allow |
| shebang-regex@3.0.0 | B | source | none (one regex) | allow |
| retry@0.12.0 | B | **not reviewed at this version** | (0.13.1 was reviewed: setTimeout backoff only) | escalate |
| typebox@1.3.7 | B | source | none; `Compile()` does **no** `new Function` codegen | allow |
| partial-json@0.1.7 | B | source | none (streaming JSON parse) | allow |
| @opentelemetry/api@1.9.0 | B | source | none observable — no-op with no SDK installed | allow |
| agent-base@7.1.4 | B | source | `http.Agent` subclass + socket bookkeeping; no hardcoded hosts | allow |
| highlight.js@10.7.3 | B | source | regex lexer + grammar data; DOM code unreachable under Node | allow |
| openai@6.26.0 | C | source (452 files) | HTTPS to api.openai.com or configured baseURL, named env reads, ffmpeg spawn (dead), `migrate` CLI runs remote tarball (dead) | escalate |
| @silvia-odwyer/photon-node@0.3.4 | C | **wasm** | loads own 1.88MB WASM from disk, `WebAssembly.Module/Instance`, ~194 pixel-math exports | escalate |
| @mariozechner/clipboard@0.3.9 | C | **native** | loads prebuilt `.node`; clipboard read/write/watch; `execSync` for musl detection; NAPI env reads | escalate |
| @mariozechner/clipboard-darwin-arm64@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-darwin-universal@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-darwin-x64@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-linux-arm64-gnu@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-linux-arm64-musl@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-linux-riscv64-gnu@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-linux-x64-gnu@0.3.9 | C | **native** | prebuilt native binary; the only one materialized here, strings-inspected | escalate |
| @mariozechner/clipboard-linux-x64-musl@0.3.9 | C | **native** | prebuilt native binary, metadata only (libc mismatch, never extracted) | escalate |
| @mariozechner/clipboard-win32-arm64-msvc@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |
| @mariozechner/clipboard-win32-x64-msvc@0.3.9 | C | **native** | prebuilt native binary, integrity-hash only | escalate |

**Network endpoints across the whole closure.** Exactly one hardcoded remote host exists in any shipped
package: `https://api.openai.com/v1` (openai SDK default `baseURL`, `client.js:132`) — and strape's own
wrappers always override it with an explicit `baseURL` from model config. Everything else is either a
caller-supplied origin, a proxy taken from `HTTP(S)_PROXY`, an inert URL *template* (hosted-git-info), a
URL inside a comment or an error message (undici, jiti/babel), or `http://localhost:9999`, undici's
placeholder origin for a mock pool that never opens a socket. **No telemetry, analytics, beacon or
update-check endpoint was found anywhere.** No package in the closure phones home.

---

## Findings and escalations

Ordered by what a human should look at first. Each item names the package, the fact, and the action.

### 1. undici — cross-origin redirect replays the request body (live path, exercised on every model call)

`fetch()` strips `Authorization` / `Cookie` / `Proxy-Authorization` on a cross-origin redirect
(`lib/web/fetch/index.js:1350-1358`) but, per the fetch spec, keeps every *other* header and **replays the
request body** on 307/308. The first pass filed this as a design note. The adversarial pass proved it is
live: strape's provider code (`@earendil-works/pi-ai/dist/providers/openai.js`, `xai.js`) calls the global
`fetch()` that `undici.install()` replaces (`packages/coding-agent/src/core/http-dispatcher.ts:108`), and
the low-level `Client`/`Pool` dispatchers strape builds *cannot* follow redirects at all
(`lib/core/request.js:162` throws), so `fetch()` is the only redirect path — and it runs on every call.
A DNS-hijacked or compromised provider host answering `307` would receive the full conversation body at an
attacker origin. Bearer tokens are stripped, so the key itself is safe today; an `api-key` / `x-api-key` /
`OpenAI-Organization`-style header would not be.
**Human must decide:** an origin allowlist at the dispatcher level in
`packages/coding-agent/src/core/http-dispatcher.ts`, or `redirect:"error"` on provider fetches.
`stripHeadersOnCrossOriginRedirect` exists only for `undici.request`, not for `fetch`.
**Also:** re-diff `lib/dispatcher/agent.js` and `lib/core/request.js:162` on every undici bump — a future
default redirect interceptor on `Agent`/`Pool` would silently move this boundary. Pin is 8.9.0 while
8.10.0 is current (no advisory affects 8.9.0, but this is the package where a CVE matters most).

### 2. jiti — the adversarial pass contradicted the first pass on babel-config lockout

First pass: jiti's compiler-hijack surface is "explicitly shut off". Second pass, from the bytes:
`dist/babel.cjs`'s `transform(r)` spreads a caller-supplied `...r.babel` **after** the safe defaults and
**before** `plugins`, so `babelrc`, `configFile`, `cwd`, `compact`, `retainLines` and `filename` are all
overridable through the public, documented `JitiOptions.transformOptions.babel` field. Only `plugins` is
genuinely protected. It is a *default contingent on strape's call site*, not a package invariant.
Grep confirms strape sets `transformOptions` nowhere today, so a hostile repo cannot currently reach a
`babel.config.js` when strape compiles an extension.
**Human must:** add a lint/test asserting no call site threads repo-controlled data into
`transformOptions.babel`, and re-check at every jiti bump and every change to
`packages/coding-agent/src/core/extensions/loader.ts`.

### 3. jiti — executable code cached to `/tmp` and re-executed on a content-hash match

`loader.ts:444` passes only `{moduleCache:false}`, so `fsCache` defaults **true**. Confirmed empirically:
transpiled extension code is written to `/tmp/jiti/<name>.<hash>.mjs`, `mkdirSync` is called with no
explicit mode (observed `775` dir / `664` files under world-writable sticky `/tmp`), and `getCache()`
accepts any cached file whose trailing marker equals `/* v9-<md5(source,16)> */` — a hash of the *readable
source*, not a secret — then hands it to `vm.runInThisContext` in the main realm with the developer's API
keys and repo access. Requires a hostile local user or prior local code execution, so low severity on a
single-user box, but the fix is one line: an explicit `fsCache` path under the user's own cache dir, or
`fsCache:false`.

### 4. grok-mermaid — thin trust, and a confirmed prototype-chain read

The code is clean and unusually deliberate (strips C0/C1 controls at every entry to prevent ANSI injection
into scrollback; hard layout caps), it has **no dependencies key at all**, a full token-level dist↔src diff
across all 10 modules shows only `sourceMappingURL` differences, and `npm audit signatures
--include-attestations` was actually run: a valid sigstore/SLSA v1 attestation exists for this tarball.
But: created 2026-07-28, `0.2.2` published 2026-08-04 (~2 days before review), single maintainer,
~1.2k downloads/month, README states "100% of the code written by Opus 5". Provenance proves CI built the
tarball from a matching tag; it does **not** prove the tag is benign, and there is effectively zero
community-scrutiny window on this point release. The exact pin + integrity hash is doing all the
protective work.
**Human must choose:** accept the pin, **vendor it** (~1400 lines of dependency-free string math into
`strape/vendor/`, which removes both the update-time review burden and registry-mutation risk), or drop
mermaid rendering. Dropping is not warranted on security grounds alone.
**Bug to fix (cosmetic, reproduced by running the shipped `dist/index.js`):** `src/labels.ts:75` /
`dist/labels.js:64` does `NAMED_ENTITIES[body]` on attacker-controlled text, so inherited
`Object.prototype` keys resolve — `flowchart LR\n A["&valueOf;"] --> B` renders a box containing
`function valueOf() { [native code] }`. A *read*, not pollution: nothing is written, no control character
escapes, no crash. Fix with `Object.hasOwn` or `Object.create(null)`. Every other lookup table in the
package was audited; this is isolated, not a pattern.
**Also:** `packages/coding-agent/src/modes/interactive/components/mermaid.ts:75` calls `render()` with no
`try/catch` anywhere up the chain (60k fuzz cases threw nothing, but a wrapper would stop a future parser
regression from breaking TUI rendering).

### 5. retry — version mismatch; the shipped tarball was never reviewed

`npm-shrinkwrap.json` ships **retry@0.12.0**. `node_modules/retry` is **0.13.1**, and the review was
performed against the installed 0.13.1 tree. No verdict exists for the 0.12.0 tarball that this entry's
integrity hash pins, and the 0.13.1 findings do not transfer.
**Human must:** resolve the drift (regenerate the shrinkwrap so the pin matches what is installed and
reviewed, or install and review 0.12.0 specifically), then record the verdict. This is a review-process
gap, not a code finding — and it is exactly the kind of thing the gate exists to surface.

### 6. proper-lockfile — time-based stale reclamation on strape's auth/session locks

Stale-lock recovery is time-based (default 10s, `lib/lockfile.js:52,67,84-86,219`), not PID- or
ownership-based. If a legitimate holder stalls past `options.stale` — slow disk, GC pause, `SIGSTOP`,
laptop suspend — a second local writer steals the lock and **both processes believe they hold it**; the
`ECOMPROMISED` callback fires only for the original holder while the new acquirer proceeds normally.
strape locks auth/session files with this.
**Human must:** review every call site and set a deliberately generous `stale`/`update` rather than
relying on defaults. Secondary: the lock path defaults to `<file>.lock` in the same directory with no
permission hardening (`lib/lockfile.js:11-13,29`), so a local attacker can pre-create it to DoS
acquisition — no new privilege (they already have write access to the auth file), but it defeats strape's
own locking guarantee. Also: no upstream release since 2022 at ~84M downloads/month; expect no fixes.

### 7. glob / path-scurry — workspace containment is a caller-side control

`glob`'s absolute-pattern handling is by design: a leading `/` (or drive/UNC root) is consumed and matching
starts at filesystem root, ignoring `cwd` (`dist/commonjs/pattern.js:68-199`). `path-scurry`'s `realpath`
resolves symlink chains with no concept of staying under a root (`index.js:1117-1145`).
**Human must verify in strape's own code:** (a) that any find/grep tool forwarding a user- **or
model-supplied** glob rejects absolute patterns and `..`, or pins `root`/`cwd` and checks results stay
under it; (b) that no call site sets `follow:true` (default is off), which would let a crafted in-repo
symlink walk traversal outside the workspace; (c) that no realpath result feeds a subsequent fs operation
without a containment check. Neither package can fix this — they are honest primitives.
Secondary (documented, not hidden): path-scurry caches stat/readdir results, so mid-session filesystem
mutation is a TOCTOU consideration for strape's file tools.

### 8. marked — zero XSS protection, safe only because of two strape invariants

The installed package returns raw HTML unchanged and its URL cleaner only `encodeURI()`s — no
`javascript:`/`data:` filtering. That is marked's long-documented posture since `sanitize` was removed
upstream, not a defect in this build. It is acceptable *only* because (a) the live consumer
`packages/tui/src/components/markdown.ts:612-616` renders the `html` token as **inert plain text** (no DOM
in that path), and (b) strape's HTML export does not use `node_modules/marked` at all — it uses a vendored
`vendor/marked.min.js` plus a `sanitizeMarkdownUrl()` scheme allowlist and `escapeHtml()`
(`export-html/template.js:616-626,1587-1594`).
**Human must:** record this as a standing invariant and re-verify on every upstream sync that nothing feeds
`node_modules/marked` output into a DOM or an exported document.

### 9. http-proxy-agent — is the Bedrock path actually unreachable?

The only in-repo consumer is `packages/ai/src/api/bedrock-converse-stream.ts:27,204`, backing the AWS
Bedrock provider, which strape declares out of scope and blocks via `strape/runtime/deny-modules.mjs`.
**Human must:** confirm that guard genuinely prevents this proxy-capable code from being reached in a
shipped run, confirm `bedrock-converse-stream.ts` does not pass `rejectUnauthorized:false` (the package
never weakens TLS itself — it spreads caller `connectOpts` into `tls.connect`), and consider whether a
package reachable only from a deliberately-dead provider belongs in the shipped closure at all.

### 10. yaml — the `--visit` bin must stay dead

`parse()` is used with **no options** on attacker-influenced skill/prompt frontmatter
(`utils/frontmatter.ts:35`, `harness/skills.ts:320-322`, `harness/prompt-templates.ts:209-211`), and the
safe defaults were verified: `core` schema with no `!!js/function` tag anywhere in the tree, and
`maxAliasCount:100` blocking billion-laughs (`dist/nodes/Alias.js:70-74`). Prototype pollution is
correctly mitigated via `Object.defineProperty` rather than assignment
(`dist/nodes/addPairToJSMap.js:24-31`). But the package ships a bin whose `--visit` flag dynamically
`import()`s a user-supplied module path (`dist/cli.mjs:124`) — a real code-execution surface, dead today.
**Human must:** confirm nothing wires up or shells out to yaml's bin, and confirm strape's runtime resolves
the `node` export condition (not the `browser` fallback) so the audited implementation is what runs.

### 11. cross-spawn — the "POSIX is dead code" conclusion belongs to strape, not to the package

Both passes cleared the package: tarball byte-identical to a fresh `npm pack`, and the post-CVE-2024-21538
escaping is genuinely fixed, not just version-bumped (fuzzed to 200k chars of adversarial
backslash/quote input at strictly linear time). But the conclusion that `escape.js` / `resolveCommand.js` /
`readShebang.js` / `enoent.js` never execute on Linux/macOS is a property of
`packages/coding-agent/src/utils/child-process.ts:25,34`, which gates `crossSpawn` behind
`process.platform === "win32"`. That file is upstream pi's and reachable by future merges; if a merge
widens or drops the gate, the whole Windows surface goes live on POSIX with **zero change to this
package**.
**Human must:** re-check that specific call site on every upstream sync. Windows-path behaviour notes, all
upstream-known and non-exploitable: COMSPEC-derived shell binary; transient process-global `cwd` mutation
(no event-loop window); exit code 1 converted to a spurious `ENOENT` when the command file did not resolve,
which can mask a real exit status.

### 12. which — a `prepublish` entry the `hasInstallScript` flag does not capture

`which@2.0.2`'s own `package.json` carries a `prepublish` script. npm does not run `prepublish` for a
registry-tarball dependency and strape installs with `--ignore-scripts`, so it cannot execute — but note
that this entry's `hasInstallScript: false` (taken from the shrinkwrap) does **not** cover
`prepublish`-class entries, so the flag alone is not a sufficient signal. Recorded rather than assumed
away. The code itself is clean and, despite the name, never spawns anything.

### 13. signal-exit — process-wide exit-handling privilege (acknowledge)

Patches `process.emit` and `process.reallyExit` (`index.js:165-201`). That is its documented entire
purpose and the behaviour matches exactly, but it means any future malicious change here owns **all** exit
handling in the agent, including strape's own cleanup and lock release. This is also the legacy *unscoped*
v3, pulled in transitively by proper-lockfile.
**Human should:** acknowledge the privilege, and consider consolidating on the modern scoped `signal-exit`
rather than carrying a v3 that receives no upstream attention.

### 14. lru-cache — the reviewed artifact is not the shipped entry point

The published entry is `dist/commonjs/index.min.js` (minified). The audit was performed against the
unminified `dist/commonjs/index.js` (1715 lines) and confirmed to match.
**Human must:** accept that substitution explicitly, and on every bump re-diff the minified entry against
the unminified source rather than reading only the readable file. A minified-only entry point is precisely
where a tampered build would hide.

### 15. openai SDK (Tier C) — grep coverage, not a line-by-line read

Zero lifecycle scripts, readable Stainless codegen (no minification), Apache-2.0, official publisher,
pinned by sha512. strape's wrappers always pass an explicit `baseURL`/`apiKey`, so SDK env defaults do not
determine where traffic goes. But ~440 of 452 files (`resources/**`, `beta/**`) were **not** read line by
line; coverage was full-tree greps for network hosts, `child_process`, `eval`/`vm`, fs writes,
native/WASM, dynamic require, env reads and telemetry strings, plus targeted reads of the paths strape
actually invokes. A backdoor confined to one rare resource file and triggered by an unusual API parameter
could evade that. **No tarball-vs-GitHub-tag diff was performed.**
**Human must:** accept that boundary, or close it (`npm audit signatures` / provenance verification, and
a source diff if risk appetite demands). Two latent surfaces to keep dead: `bin/cli`'s `migrate`
subcommand downloads and executes a third-party GitHub release tarball via `npx` (only if a human types
`openai migrate`), and `helpers/audio.js` spawns `ffplay`/`ffmpeg` (not imported by strape).

### 16. photon-node (Tier C) — the only WASM blob in the closure

`package.json` has **no `scripts` key at all**, so the install-time surface is provably zero. The JS glue
(137KB + 124KB of unminified, rustdoc-commented wasm-bindgen output) was read and grepped in full: no
network, exec or env capability, and the wasm-bindgen import table is fully enumerated in the JS with no
fs/net-capable import. `file` confirms a genuine WASM binary; `strings` found no URL beyond an Apache-2.0
header and an Adobe XMP namespace (consistent with the bundled Roboto font used by the text/watermark
feature). The 1.88MB of compiled Rust itself is unreviewable.
**Human must decide:** strape calls only ~6 of ~194 exports (`PhotonImage` ctor / `new_from_byteslice` /
`__destroy_into_raw`, `resize` with Lanczos3, `fliph`, `flipv`) from `utils/photon.ts`,
`image-resize-core.ts`, `image-convert.ts`, `clipboard-image.ts`, `exif-orientation.ts`. If image
attachments are not core to an OpenAI/xAI-only mission, dropping this removes the **only** WASM blob from
the closure — the escalation path `strape/audit/high-scrutiny.json` already names. If kept: single
maintainer, and every version bump is high-scrutiny (re-diff the wasm bytes; do not re-trust the
maintainer).

### 17. @mariozechner/clipboard + 10 platform sidecars (Tier C) — native binaries that read everything you copy

Zero lifecycle scripts on the parent **and** all 10 sidecars. `index.js` (25986 bytes) is plain readable
NAPI-RS loader code that deterministically selects one binary by platform/arch/musl detection and requires
it by literal path — no untrusted string concatenation, no network. The live binary
(`clipboard.linux-x64-gnu.node`, 1,378,264 bytes) is a stripped ELF64 shared object; `strings` shows only
NAPI glue, Rust panic strings, X11/XFixes protocol names and Cargo provenance paths (`napi-3.9.0`,
`tokio-1.49.0`, `x11rb-0.13.2`, `image-0.25.5`, `rustix-1.1.3`, `base64-0.22.1`, `libloading-0.9.0`) —
**no hardcoded network host or URL of any kind**. Every other sidecar was audited at
`package.json`/integrity level only; `linux-x64-musl` is present as metadata with its binary never
extracted.
**Human must:** (a) accept that the machine code cannot be reviewed from `node_modules` — this rests on
integrity pinning, provenance strings matching the claimed crate stack, zero install-time execution, and a
narrow gated call site; (b) **independently re-verify the sha512 hashes against the live npm registry**,
which this review did not do (no outbound network call was made); (c) note the loader honours
`NAPI_RS_NATIVE_LIBRARY_PATH` (`index.js:64-69`) to override which `.node` is required — generic NAPI-RS
scaffolding, not remotely exploitable, but an attacker who already controls the developer's dotfiles can
redirect clipboard loading to an arbitrary local binary; (d) weigh the value — strape calls only 4 of 17
exports (`getText`, `setText`, `hasImage`, `getImageBinary`) from
`packages/coding-agent/src/utils/clipboard-native.ts:14-23`, gated on no `TERMUX_VERSION` and
(non-Linux or `DISPLAY`/`WAYLAND_DISPLAY` set). `watch()`, RTF, HTML and `clear()` are unused surface on a
package that by definition can read everything the user copies.

---

## What could not be read

Stated plainly, because a review that hides its boundary is worse than no review.

1. **`@mariozechner/clipboard`'s prebuilt `.node` binaries (11 packages).** Stripped compiled Rust. One
   was strings-inspected; the other ten were not inspected at all (npm prunes by platform, so nine never
   materialized and `linux-x64-musl`'s binary was never extracted). Nothing about their *behaviour* is
   established by reading `node_modules`. The only way to raise this is a reproducible build of
   `clipboard-rs` from the pinned upstream commit and a per-platform byte diff.
2. **`@silvia-odwyer/photon-node`'s 1.88MB `photon_rs_bg.wasm`.** 83% of the package's bytes. The review
   establishes the *absence* of suspicious strings and the *shape* of its import table; it cannot rule out
   logic gated on rare or adversarial input bytes.
3. **The openai SDK's ~440 unread resource/schema files.** Grep-covered for every named risk category,
   not read. And no tarball-vs-tag diff was performed for it.
4. **jiti's 1.7MB of minified bundle** (`dist/jiti.cjs` 188KB on one line, `dist/babel.cjs` 1.5MB) —
   embedded `@babel/core`, acorn, get-tsconfig, std-env. Justified by purpose (a compiler must ship a
   compiler) and compensated by the integrity pin and the absence of any network/`child_process`
   primitive, but no human reads it. Same class, smaller: `lru-cache`'s minified entry and `glob`'s
   `index.min.js` esbuild bundle (both cross-checked against readable siblings).
5. **`retry@0.12.0`** — not read at all; 0.13.1 was read instead. See finding 5.

Everything else in the closure is source that a human can read end to end, and most of it was.

---

## Residual risk

What this review structurally cannot cover, and what compensates.

**Thin-trust packages that are clean today.** `grok-mermaid` is nine days old with one maintainer;
`@mariozechner/clipboard` is a personal fork of a fork. Reading the code proves the *current* tarball is
benign; it says nothing about the maintainer's account security or their next release. *Compensating
control:* exact-version pins with sha512 integrity in `npm-shrinkwrap.json`, so an install can never
silently drift, plus `strape/audit/high-scrutiny.json` which names these as requiring re-review rather
than re-trust on any bump.

**Minified and generated artifacts.** jiti's bundled compiler, lru-cache's and glob's minified entries.
Where a readable sibling exists it was diffed; where it does not, the pin is the control. *Compensating
control:* on every bump, re-run the mechanical checks (tarball↔`node_modules` diff, capability greps for
`child_process`/`eval`/`Function`/`vm`/network) rather than reading a changelog.

**Native and WASM binaries.** Two families, both Tier C, both unreviewable by inspection. *Compensating
control:* integrity pinning, zero install scripts, narrow gated call sites, and — for photon — a live
option to delete the dependency entirely.

**A future version can differ entirely from the reviewed one.** This is the load-bearing residual risk.
Every verdict here is a statement about one specific tarball identified by one specific sha512. Nothing in
this document generalizes to `undici@8.10.0` or `openai@6.27.0`. *Compensating controls:* the
`reviewed-deps.mjs` gate fails on any integrity change (a bumped version is an unreviewed version, by
construction); a **minimum release age** policy so brand-new point releases are not adopted inside the
window where a compromised publish is typically caught; **SBOM drift** detection against
`strape/audit/sbom-v0.84.0.json`; and the **high-scrutiny register** for the packages where a bump must
trigger a full re-read rather than a hash update.

**Install-time execution.** Currently zero, and enforced two ways: `strape/scripts/lockfile-audit.mjs`
gates `install`/`preinstall`/`postinstall`, and installs run `--ignore-scripts`. Note the gap finding 12
records: `hasInstallScript` does not capture `prepare`/`prepublish`/`prepack` entries, five of which exist
in the closure (all inert for a registry install).

**What strape's own code does with these primitives** is out of scope here and covered by the source
audit — but findings 1, 3, 6, 7, 8, 9, 10 and 11 are all cases where the *package* is fine and *strape's
call site* is the control. Those must land as source-side work items, not be closed by this file.

---

## Not covered by this review

**`rg` (ripgrep) and `fd` are NOT npm packages** and are therefore absent from
`packages/coding-agent/npm-shrinkwrap.json` and from this review entirely. They are external binaries
provisioned by `strape/scripts/provision-tools.mjs` and tracked in `strape/audit/vendored-tools.json`.
They are prebuilt native executables that the agent invokes with model-influenced arguments, so their
supply-chain posture matters at least as much as anything above — but it is a *different* control
(download URL, checksum pinning, and provenance of the release artifact) and needs its own review against
that script. Do not read this document as clearing them.

Also out of scope: internal `@earendil-works/pi-*` workspace packages (first-party source audit),
devDependencies not present in the shipped closure (`execa`, `vite`, `tshy`, etc.), and the vendored
`vendor/marked.min.js` used by HTML export (first-party vendored code, not an npm dependency).

---

## Decisions — 2026-08-08

The 26 open escalations were resolved on 2026-08-08. Each verdict in `reviewed-deps.json` now carries a
`decision` field alongside the original `notes`; the notes are preserved **verbatim**, because they are the
evidence and the decision is a separate act. Nothing below fills `reviewedBy` / `reviewedAt` — that is still
a person's to do, and `review-attest --record` is still what binds it.

**One policy call, applied to 13 Tier C artifacts** — the 10 `@mariozechner/clipboard` platform sidecars, the
parent package, `@silvia-odwyer/photon-node` and `openai`. The assurance actually available for an artifact
nobody can read is: the exact version pinned by sha512, zero lifecycle scripts verified directly, publisher
provenance, and a narrow reviewed call site. Reviewing stripped machine code or WASM from `node_modules` is
not achievable, and per-platform reproducible builds are disproportionate to the threat this fork models.
Accepted, with the condition that **any version bump is a high-scrutiny event** — re-verify integrity and
provenance rather than re-trusting the maintainer. `photon-node` is **kept** rather than dropped: image
attachment is a real capability for a coding agent, and it stays registered in `high-scrutiny.json` as the
closure's only WASM blob. Dropping image support remains the higher-assurance option if that calculus changes.

**13 Tier A/B escalations, each closed by verifying the specific caller-side fact it named:**

| Package | The question | Verified answer |
|---|---|---|
| `glob` | `follow: true` anywhere? a model-supplied pattern? | No, and no. The only `follow:` hits are `follow: "end"` on a TUI ScrollView (`interactive-mode.ts:853`, `tui-alt-screen.ts:148`). glob has **one** call site — `package-manager.ts:2306` — and no file/grep tool uses it. |
| `path-scurry` | same containment question | Closes with glob: its only consumer is glob, via that one call site. |
| `cross-spawn` | is the win32 gate intact? | Yes — `child-process.ts:25` and `:33-35`, both spawn paths. |
| `which` | the `prepublish` entry | Recorded, not assumed away. Inert for a registry tarball under `--ignore-scripts`; the shrinkwrap's `hasInstallScript` flag does not capture prepublish-class entries. |
| `marked` | who consumes it? | Three importers, all in `packages/tui`; the HTML export uses the vendored copy (`export-html/index.ts:148`). Raw-HTML passthrough is inert — no DOM in that path. |
| `yaml` | options at the call site? | `parse()` with no options (`frontmatter.ts:35`), so the verified safe defaults run. The `--visit` bin surface is dead and must stay dead. |
| `jiti` | is `transformOptions` threaded? | **Zero occurrences** across every package, so the babel-config override is unreachable today. `loader.ts:444-445` confirms `fsCache` defaults on. |
| `http-proxy-agent` | TLS, and Bedrock reachability | `rejectUnauthorized` appears nowhere in `packages/ai/src`; `@aws-sdk/client-bedrock-runtime` is blocked at `deny-modules.mjs:16`. |
| `proper-lockfile` | is `stale` set deliberately? | **Partly, and the original review missed it**: `auth-storage.ts:120,131` sets `stale: 30_000` with `onCompromised`, but `trust-manager.ts:145` and `settings-manager.ts:211` use `lockSync` defaults. |
| `signal-exit` | direct use? | None — transitive via `proper-lockfile`; upstream already carries `5724-sigterm-signal-exit.test.ts`. Privilege acknowledged. |
| `lru-cache` | reviewed artifact ≠ shipped entry | Substitution accepted explicitly; re-diff the minified entry on every bump. |
| `undici` | redirect body replay | Real and reaching strape. Fix chosen: a dispatcher-level origin allowlist in `core/http-dispatcher.ts`. |
| `grok-mermaid` | thin trust | Pin accepted **and** the dependency is to be removed — vendored into `strape/vendor/`. |

**Decisions that create work rather than closing it.** These are deliberately *not* done in the same pass as
the verdicts, because fixing code while a review is open is how a verifier ends up refuting a real finding by
reading post-fix source:

1. `undici` — origin allowlist in `core/http-dispatcher.ts`, which owns `setGlobalDispatcher` and
   `undici.install()` (lines 98, 108). Chosen over `redirect: 'error'` per provider fetch because a
   per-call-site flag is exactly what a future upstream merge drops silently.
2. `jiti` — point `fsCache` at a path under `~/.strape`, which hunk 12 already guarantees is `0700`, instead
   of world-writable `/tmp/jiti`.
3. `jiti` — a test/lint asserting no call site threads repo-controlled data into `transformOptions.babel`.
4. `proper-lockfile` — bring `trust-manager.ts:145` and `settings-manager.ts:211` in line with
   `auth-storage.ts`'s deliberate 30s stale.
5. `grok-mermaid` — vendor ~1400 lines into `strape/vendor/`, fixing the prototype-chain read
   (`labels.ts:75`) on ingest. Precedent: `vendor/marked.min.js` already backs the HTML export.
6. `mermaid.ts:75` — a defensive `try/catch` around `render()`.

## Sign-off

An agent review is **evidence**, not sign-off. As of 2026-08-08 all 50 entries carry verdict `allow` and
`node strape/scripts/reviewed-deps.mjs` passes — but `reviewedBy` and `reviewedAt` are still `null` on every
entry and no attestation exists, so `review-attest --verify` and `version.mjs --check` still fail. That is the
intended state until a person signs.

To sign off: resolve each escalation (fix, accept with recorded reasoning, or drop the dependency), flip
its verdict to `allow` **only** with the reasoning recorded in this file, and fill `reviewedBy` /
`reviewedAt`. Do not flip a verdict without a note.

```
Upstream pin reviewed:     v0.84.0
Closure reviewed:          packages/coding-agent/npm-shrinkwrap.json — 50 external packages
Verdicts at report date:   23 allow / 27 escalate / 0 unreviewed  (2026-08-06)
Verdicts after decisions:  50 allow /  0 escalate / 0 unreviewed  (2026-08-08, see Decisions above)
Review performed by:       Claude Opus 5 agents (claude-opus-5[1m]), installed tarballs under node_modules
Adversarial second pass:   undici@8.9.0, jiti@2.7.0, cross-spawn@7.0.6, grok-mermaid@0.2.2
Report date:               2026-08-06

Human reviewer name:       ______________________________________
Human reviewer date:       ______________________________________
Escalations resolved:      ______ of 27
Signature / commit:        ______________________________________
```

---

## Correction, applied after this record was written

**`retry@0.12.0` — verdict changed from `escalate` to `allow`; counts are now 24 `allow` / 26 `escalate`.**

The escalation was correct to raise but described the problem slightly wrong: it was not that the shipped
version could not be found, it was that **the review had read the wrong artifact**. The dev tree hoists
`node_modules/retry@0.13.1` for a devDependency, while the shipped closure contains
`node_modules/proper-lockfile/node_modules/retry@0.12.0` (which is what
`proper-lockfile/lib/lockfile.js:5` resolves).

Re-reviewed by hand at the correct path: zero runtime dependencies; no `install`/`postinstall`/`preinstall`/
`prepare` script (the `scripts` block is test/release only, which npm does not run on install); the shipped
`index.js`, `lib/retry.js` and `lib/retry_operation.js` contain no `child_process`, `eval`, `new Function`,
network, `fs`, `process.env` or prototype mutation — it is arithmetic over `setTimeout`. The one
`new Function()` in the package lives in `test/integration/`, which the entry point never requires.

Tooling changed so this class of error fails mechanically rather than depending on reviewer diligence:
every `reviewed-deps.json` entry now carries `shrinkwrapPath`, `reviewed-deps.mjs` fails on
`artifact-mismatch` (on-disk version at that path ≠ shrinkwrap) and `path-moved`, and
`.claude/skills/dep-review` instructs reviewers to use the nesting path verbatim and verify it first.

Full write-up: `hand-verified-findings.md` HV-7. It is the most useful thing this review produced about
*itself*: an agent review is only as good as the artifact identity it is handed.
