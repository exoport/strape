# pi Architecture: Monorepo, Build Pipeline, and Branding Surface

This file answers: what does each package in the `earendil-works/pi` monorepo do, which of them actually
ship inside the CLI a user installs, how is the CLI built and released, and how does pi's white-label
mechanism work — including what it automatically rebrands, what it misses, and why strape rejected an
npm-scope rename. Evidence is drawn from raw report `04-architecture-rename.json` (a direct code audit of
the monorepo, LOC/file counts produced by tooling) and `03-dependency-security.json` (dependency-graph
measurements produced by running `npm ci`/`npm ls` against the tree), cross-checked in this pass against
the actual `pi/` upstream mirror and the implemented `strape/` fork on disk. Facts re-verified directly in
this pass are marked "(re-verified)"; everything else is carried from the raw reports as originally
sourced (code read vs. command output), per each report's own labeling.

## 1. The monorepo: what each package does

All packages are at v0.84.0. Descriptions are from each package's own `package.json` "description" field
plus its dependency graph (04-architecture-rename.json key_facts #14).

| Package | Purpose | External prod deps | Internal deps | Ships in coding-agent's runtime closure? |
|---|---|---|---|---|
| `pi-tui` | TUI rendering | `get-east-asian-width`, `marked` (2) | 0 | Yes |
| `pi-telemetry` | Telemetry contracts/schema; ships a no-op implementation (`packages/telemetry/src/noop.ts`), no network code itself | 0 | 0 | Yes |
| `pi-ai` | "Unified LLM API" | 11: `@anthropic-ai/sdk`, `@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@mistralai/mistralai`, `@opentelemetry/api`, `@smithy/node-http-handler`, `http-proxy-agent`, `https-proxy-agent`, `openai`, `partial-json`, `typebox` | 1 (pi-telemetry) | Yes |
| `pi-agent-core` | "General-purpose agent with transport abstraction, state management, attachment support" | 4: `diff`, `ignore`, `typebox`, `yaml` | 2 (pi-ai, pi-telemetry) | Yes |
| `pi-protocol` | "Transport-neutral CBOR protocol for remote pi sessions" | 1: `typebox` | 0 | Yes (ships in shrinkwrap; not reachable from any CLI code path — see §2) |
| `pi-client` | "Transport-neutral client for remote pi sessions over framed CBOR bytes" | 0 | 1 (pi-protocol) | Yes (same caveat) |
| `pi-server` | "experimental server package for pi" | — | pi-ai, pi-protocol | **No** |
| `pi-session-backend-sqlite-node` | Node sqlite session backend for pi-agent-core sessions (uses Node's built-in `node:sqlite`, no native binding) | 0 | — | **No** |
| `pi-evals` | private, vitest-evals-based agent-quality eval harness | 0 (devDependency-only) | — | **No** |
| `pi-coding-agent` | The CLI itself | 15 external (`chalk`, `cross-spawn`, `diff`, `glob`, `grok-mermaid`, `highlight.js`, `hosted-git-info`, `ignore`, `jiti`, `minimatch`, `proper-lockfile`, `semver`, `typebox`, `undici`, `yaml`) + 1 optional (`@mariozechner/clipboard`) | 5 (pi-agent-core, pi-ai, pi-client, pi-protocol, pi-tui) | is the closure |

Root `package.json` has zero production dependencies (devDependencies only); its `workspaces` array
(upstream) lists `packages/*`, `packages/session-backends/*`, plus five
`packages/coding-agent/examples/extensions/*` directories, including `gondolin`, which pulls `ssh2` and
`cpu-features` (native, node-gyp) into the monorepo dev install — but never into the published CLI
(04-architecture-rename.json key_facts #3; 03-dependency-security.json key_facts #1, #23).

**Repo size** (04-architecture-rename.json key_facts #29): `packages/coding-agent/src` = 199 files /
~58.7k LOC; `packages/ai/src` = 174 files / ~22.4k LOC; `packages/agent/src` = 48 files / ~12.2k LOC;
`packages/tui/src` = 38 files (LOC not counted).

## 2. The CLI's dependency graph: what's dead weight

`pi-coding-agent`'s own `package.json` "dependencies" list is the complete set above. Two internal
packages ship but are functionally unreachable from the CLI's own entry points:

- **`pi-client`/`pi-protocol`** are used only inside `packages/coding-agent/src/client/remote-session.ts`
  and `transcript.ts`, re-exported via the package's `./client` export subpath as an SDK-only surface.
  `RemoteSession(` is never instantiated by `cli.ts`/`main.ts`/`interactive-mode.ts`
  (04-architecture-rename.json key_facts #16).
- The CLI's own `server` subcommand (`packages/coding-agent/src/cli/experimental/commands/server.ts`)
  defines a `runServer()` context interface with **zero implementations** anywhere in the tree — the
  remote-server feature is scaffolded but unwired (04-architecture-rename.json key_facts #17).
- `pi-server` and the sqlite session backend are not dependencies of `pi-coding-agent` at all, and are
  referenced nowhere outside their own packages (04-architecture-rename.json key_facts #15).

**Measured package counts** (03-dependency-security.json key_facts #1, run via real `npm ci`/`npm ls`
commands, "verified by running a command"): a full monorepo `npm ci --ignore-scripts` at repo root installs
339 packages total; `npm ls --all --omit=dev --parseable` across all workspaces returns 167
production-reachable entries; the lockfile's package map has 429 total entries / 386 unique names, of which
235 are dev-only. The **actual published `@earendil-works/pi-coding-agent` npm tree**, computed from its
generated `npm-shrinkwrap.json`, was **143 packages** at the upstream v0.84.0 baseline — materially smaller
than the full monorepo dev graph, because the shrinkwrap generator (§3) computes only the CLI's true
transitive closure.

### Disagreement: what should be dropped from the dependency graph

The raw reports disagree with what was actually implemented, and this disagreement is itself informative:

- **04-architecture-rename.json** (recommendations) argued for excluding `pi-client`, `pi-protocol`,
  `pi-server`, `session-backends/sqlite-node`, and `pi-evals` from strape's build/workspace list entirely,
  on the grounds that none are needed by the CLI runtime.
- **What strape actually implemented** (`strape/docs/HUNKS.md`, §3.4 of `strape-proposal.md`) kept
  `pi-client` and `pi-protocol` untouched, because they are real, already-minimal dependencies of the CLI
  (`typebox`-only CBOR plumbing) that **do** ship in the trimmed 56-package closure (confirmed present in
  `strape/audit/sbom-v0.84.0.json`: `@earendil-works/pi-client@0.84.0`, `@earendil-works/pi-protocol@0.84.0`).
  Deleting them would require also patching `build:offline` (root `package.json` line 17, which builds
  packages by name) — a sixth hunk for no measurable security gain, since they add no external
  dependencies of their own. The proposal explicitly declares this "unnecessary" and instead puts
  `packages/{server,client,protocol,evals}` and `sqlite-node` **out of security-review scope** rather than
  out of the build (strape-proposal.md §3.4, §7.3).
- `pi-server`, `sqlite-node`, and `pi-evals` were dropped from consideration the same way in both the
  recommendation and the implementation — they were already absent from the shipped closure before strape
  touched anything, so there was nothing to trim.

## 3. Build and release pipeline

### 3.1 Build scripts (verified in `pi/package.json`, re-verified in this pass)

| Script | What it does |
|---|---|
| `build` | Sequentially builds `tui -> telemetry -> ai -> agent -> session-backends/sqlite-node -> protocol -> client -> server -> coding-agent`; `packages/ai`'s step runs `generate-models`, which hits the network |
| `build:offline` | Identical chain, except `packages/ai` runs `build:offline` instead, which skips model-catalog generation and instead runs `check:model-data` + `tsgo -p tsconfig.build.json` + copies `src/providers/data` into `dist/providers/data` |
| `packages/coding-agent`'s own `build` | `tsgo -p tsconfig.build.json && chmod +x dist/cli.js dist/rpc-entry.js && copy-assets` — no bundler; ships as plain compiled ESM files, not a single bundle |
| `build:binary` | Only for the Bun-compiled single-executable path: chains the same package builds, then `bun build --compile ... --outfile dist/pi` |
| `check` | `biome check --write --error-on-warnings . && check:pinned-deps && check:ts-imports && check:shrinkwrap && check:install-lock:coding-agent && tsgo --noEmit && check:browser-smoke` |

**`tsgo`** (the `@typescript/native-preview` devDependency, a Go-based TypeScript compiler preview) is what
actually compiles the CLI — there is no esbuild bundling step in the CLI's own build (re-verified: `grep`
for esbuild usage across `packages/*/package.json` scripts found none). **`esbuild`** is a root
`devDependency` (`package.json:56`, `esbuild: 0.28.1`) used only by `scripts/check-browser-smoke.mjs`,
one step of `npm run check`, to verify a browser-facing artifact doesn't pull in Node-only APIs
(re-verified: `grep -rl esbuild scripts/*.mjs` matches only `check-browser-smoke.mjs`). It never ships to
end users — it's dev-graph only, and 03-dependency-security.json key_facts #6 independently confirmed it
has an install script but ships prebuilt platform binaries via `optionalDependencies`, so `--ignore-scripts`
doesn't break it (verified live: `node node_modules/esbuild/bin/esbuild --version` succeeded after a real
`npm ci --ignore-scripts`).

### 3.2 The offline-build caveat

`packages/ai/src/providers/data/` (per-provider model/pricing JSON — 39 files, ~600K, e.g. `xai.json`,
`openai.json`) is git-ignored upstream (`.gitignore:11`) and **does not exist in a fresh clone**. A first
`build:offline` fails its `check:model-data` gate ("Model data is missing or stale. Run
`npm run hydrate:model-data`") until that directory is hydrated once via network
(`npm run hydrate:model-data`, which hits `models.dev/api.json` plus OpenRouter/NVIDIA/Vercel AI Gateway
APIs) or copied from a previously published npm tarball, since `pi-ai`'s `files` field ships
`dist/providers/data` in every release (04-architecture-rename.json key_facts #24;
01-compat-providers.json key_facts #19). **So "build fully offline from the git tree" is true only after
one prior network-dependent hydration — it is not offline on a bare clone with zero prior state.**

strape resolved this by committing the hydrated data directory (see §5 below and
`strape/research/03-dependency-security-baseline.md`), turning it from a per-build network dependency into a
reviewable git diff.

### 3.3 Supply-chain generator scripts

| Script | Role |
|---|---|
| `scripts/check-pinned-deps.mjs` | Walks every `package.json`, fails if any external dependency (non-`@earendil-works/pi-*`, non-workspace) isn't an exact `X.Y.Z` semver |
| `scripts/generate-coding-agent-shrinkwrap.mjs` | Computes `pi-coding-agent`'s full transitive closure from `package.json` graphs + the root `package-lock.json` (no `node_modules` needed); writes `packages/coding-agent/npm-shrinkwrap.json` (shipped in the published tarball) with resolved URLs + sha512 integrity per package; hard-codes a 2-entry `allowedInstallScriptPackages` allowlist and fails the build if any other package has an install script, or if a previously allowlisted package disappears (stale-allowlist detection) |
| `scripts/generate-coding-agent-install-lock.mjs` | Produces a standalone install root (`packages/coding-agent/install-lock/{package.json,package-lock.json}`) for a synthetic `@earendil-works/pi-coding-agent-install` package, used by self-update/local-release tooling for a fully pre-resolved install that bypasses npm's registry resolver |
| `scripts/local-release.mjs` | Builds and packs all 9 publishable packages to tarballs, creates an isolated local install outside the repo (`--skip-install`, `--force` flags) for release testing without touching the public npm registry |

(03-dependency-security.json key_facts #7, #11, #12; 04-architecture-rename.json key_facts #25-26.)

## 4. The branding surface: piConfig and what it misses

### 4.1 The mechanism (verified by reading `config.ts`, re-verified in this pass at the cited lines)

```ts
// packages/coding-agent/src/config.ts
const piConfigName: string | undefined = pkg.piConfig?.name;                          // :487
export const APP_NAME: string = piConfigName || "pi";                                  // :489
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";                        // :490
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";               // :491
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;             // :495
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;   // :496
```

`pkg` is `packages/coding-agent`'s **own** `package.json`, read via `getPackageDir()`
(`config.ts:367-388`), which walks up from the coding-agent module's own `__dirname` (or
`dirname(process.execPath)` for the Bun binary) — not from an invoking wrapper script. The only override,
`PI_PACKAGE_DIR` (`config.ts:369`), is intended for Nix/Guix store-path issues and would require mirroring
the entire `dist/` asset tree to be useful for rebranding (04-architecture-rename.json key_facts #21,
risks #3).

Setting `piConfig: {name: "strape", configDir: ".strape"}` and `bin: {strape: "dist/cli.js"}` in that one
file is sufficient to rebrand ~13 consuming files with no further edits: `cli.ts` (process title),
`main.ts`, `slash-commands.ts:41`, `export-html/index.ts:277,311`, `cli/args.ts` (help/usage text, ~25
lines), `package-manager-cli.ts`, `interactive-mode.ts` (logo, terminal title, update prompts),
`rpc-entry.ts`, `bun/cli.ts`, `first-time-setup.ts:56`, `tools-manager.ts:112` (User-Agent header)
(04-architecture-rename.json key_facts #6). This was independently and empirically validated by **both**
competing design proposals before a rename was chosen (05-design-minimal-effort.json and
06-design-security-first.json both ran `./pi-test.sh --help` against a live rebrand and confirmed the
output), and is the exact hunk shipped in the strape repo
(`git diff v0.84.0..main -- packages/coding-agent/package.json`, confirmed in this pass):

```diff
 "piConfig": {
-		"configDir": ".pi"
+		"name": "strape",
+		"configDir": ".strape"
 },
 "bin": {
-		"pi": "dist/cli.js"
+		"strape": "dist/cli.js"
 },
```

### 4.2 What piConfig does *not* automatically fix

One un-parameterized literal string survives the rename mechanism: `system-prompt.ts:121` hardcodes
"You are an expert coding assistant operating inside pi, a coding agent harness", and a nearby line (~131)
says "Pi documentation" — neither uses `APP_NAME`, so a rebrand via `piConfig` alone still tells the
**model** it is pi (04-architecture-rename.json key_facts #8). This is the only hunk in strape's six-hunk
divergence that changes *behavior* rather than cosmetics (`strape/docs/HUNKS.md` hunk 3), confirmed
implemented in this pass:

```diff
-	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness.
+	let prompt = `You are an expert coding assistant operating inside strape, a coding agent harness.
...
-Pi documentation (read only when the user asks about pi itself, ...
+strape documentation (read only when the user asks about strape itself, ...
```

A **live example of incomplete-branding risk in the wild**: a real downstream rebrand
(`badlogic/pi-mono#3476`, per 02-pi-dev-upstream.json key_facts #22, sourced via WebSearch and not
independently re-verified in this pass) hit a hardcoded `"Quit pi"` string that didn't use `APP_NAME` —
confirming that `piConfig` rebranding works overall but not with 100% string coverage, and any rebrand
should grep for residual hardcoded "pi" strings post-rename.

Upstream anticipates forking/rebranding as a first-class use case: `startup-ui.ts:26-42` defines
`OFFICIAL_PACKAGE_NAME`/`OFFICIAL_APP_NAME`/`OFFICIAL_CONFIG_DIR_NAME` and `isOfficialDistribution()`,
used at `startup-ui.ts:115-131` to skip the official first-time-setup/telemetry flow for any distribution
that changes package name, app name, or config dir (01-compat-providers.json key_facts #10;
04-architecture-rename.json key_facts #7). `packages/coding-agent/docs/development.md` has a documented
"Forking / Rebranding" section describing exactly this mechanism (02-pi-dev-upstream.json key_facts #4),
and `docs/extensions.md:953` explicitly instructs extension authors to use `CONFIG_DIR_NAME` instead of
hardcoding `.pi` "because rebranded distributions can use a different config directory name"
(02-pi-dev-upstream.json key_facts #5).

### 4.3 Why the npm scope rename was rejected

469 files repo-wide reference the `@earendil-works/pi-` npm scope as import specifiers
(04-architecture-rename.json key_facts #28). Renaming this scope was considered and rejected by every
design pass (05, 06) and the final proposal, for the same reason each time: **zero value for a fork that
never publishes to the public npm registry, and a permanent, ever-growing upstream-merge-conflict surface**
(strape-proposal.md §3.4, §6). The only user-facing rename that matters is the single `bin`/`piConfig` seam
in `packages/coding-agent/package.json` (~13 consuming files) plus the two `system-prompt.ts` strings — a
~7-line total diff, versus a 469-file diff for the scope rename that upstream would re-touch on nearly
every dependency bump.

`strape/docs/HUNKS.md` records the same decision as implemented policy: "Deliberately not renamed: the npm
scope (`@earendil-works/pi-*`, ~469 files, zero value for a fork that never publishes) and the literal
`PI_*` env vars." The package `name` field in `packages/coding-agent/package.json` was left as
`@earendil-works/pi-coding-agent` in the actual implementation (confirmed by `git diff` in this pass — only
`piConfig` and `bin` changed, not `name`), a detail slightly more conservative than one of the two design
proposals (05-design-minimal-effort.json), which had proposed also renaming the package `name` to
`@exo/strape-coding-agent`. The shipped decision was to leave `name` untouched, accepting that
`isOfficialDistribution()` already flips to `false` from `piConfig.name` alone.
