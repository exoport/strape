# Building and installing strape

strape is **never installed from the npm registry**. It is built from a reviewed source tree and distributed
as a local artifact. That is the point: the review gate is worthless if the thing you run came from somewhere
else.

Prerequisites: Node >= 22.19.0, git. No global npm installs required.

## 1. Build from the reviewed tree

```sh
git clone <your strape remote> strape && cd strape
git checkout main                                   # vendor + the twelve hunks

npm ci --ignore-scripts --no-audit --no-fund        # never omit --ignore-scripts
node strape/scripts/verify-overlay.mjs              # are all twelve hunks intact?
node strape/scripts/lockfile-audit.mjs              # registry/https/integrity/pin hygiene
node strape/scripts/reviewed-deps.mjs --report      # THE GATE — must print PASSED
npm run build:offline                               # no network: the model catalog is vendored
```

`reviewed-deps.mjs` failing is not a problem to route around — it means a shipped dependency has no recorded
human verdict. Review it (`.claude/skills/dep-review`) and record the verdict. A build produced by bypassing
the gate has no claim to having been reviewed.

Verify the result:

```sh
node packages/coding-agent/dist/cli.js --version
node packages/coding-agent/dist/cli.js --help | head -1     # must say "strape - …"
node strape/scripts/compat-test.mjs                          # CLAUDE.md + .claude/skills interop
```

## 2. Install for daily use

The simplest correct install is a built checkout plus the launcher:

```sh
mkdir -p ~/.local/lib ~/.local/bin
cp -a . ~/.local/lib/strape                  # or: git clone the reviewed tree there and build in place
ln -sfn ~/.local/lib/strape/strape/bin/strape ~/.local/bin/strape
strape --version
```

`strape/bin/strape` sets `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` by default, and loads the module guard.
Point it elsewhere with `STRAPE_ROOT=/path/to/built/checkout strape …`.

### Isolated install via upstream's packer (optional)

`scripts/local-release.mjs` packs every workspace to tarballs and creates an install outside the repo whose
`package.json` maps each internal package to a `file:` tarball with matching `overrides`, then runs
`npm install --omit=dev --ignore-scripts`. That is the right shape for handing a build to someone else.

Note its shim hardcodes the binary name `pi`, so create the strape symlink yourself (step above).

**Do not `npm install` from `packages/coding-agent/npm-shrinkwrap.json` directly.** Upstream's generator emits
public-registry URLs with **no integrity hashes** for the six internal `@earendil-works/pi-*` packages, so
that path would fetch them unverified. `lockfile-audit.mjs` prints this as a note on every run. Build the
internal packages from source (as above) or use `file:` tarballs.

## 3. Provision the external binaries — hash-verified

The `grep` and `find` tools shell out to `rg` and `fd`. Upstream downloads them at runtime from GitHub's
*latest release* and executes them with **no checksum or signature** (`utils/tools-manager.ts:108-123`,
`:265-271`). `PI_OFFLINE=1` blocks that path, which is why the launcher sets it — but then `grep`/`find`
silently degrade. Install pinned, verified binaries instead:

```sh
node strape/scripts/provision-tools.mjs           # verifies sha256 from strape/audit/vendored-tools.json
node strape/scripts/provision-tools.mjs --verify   # re-check what is installed
```

They land in `~/.strape/agent/bin`, which is exactly where the harness looks (`config.ts:549`). If your
platform has no recorded hash the script **refuses to install** — record one on a trusted machine with
`--record`, verify provenance against the release page by hand, then commit the manifest.

Already have system `rg`/`fd`? Upstream prefers a system binary over downloading, so that works too — but
then their provenance is your package manager's problem, which is usually a good trade.

## 4. Configure for Grok / OpenAI / Gemini and Claude Code interop

```sh
node strape/scripts/claude-compat.mjs --global               # settings + ~/.claude/CLAUDE.md symlink
node strape/scripts/claude-compat.mjs --project /path/to/repo   # per-repo .claude/skills reuse
```

`--global` writes `~/.strape/agent/settings.json` with `defaultProvider: xai`, `defaultModel: grok-4.5`,
`enabledModels: ["openai/gpt-*", "xai/grok-*", "gemini-openai/*"]`, `enableInstallTelemetry: false`,
`defaultProjectTrust: "ask"`, and adds `~/.claude/skills` when it exists. It never overwrites a value you
already set.

Those patterns are **provider-scoped on purpose.** They match against `provider/id` as well as bare `id`
(`core/model-resolver.ts:312-316`), so a bare `gemini-*` would also match the ~24 models of pi's built-in
`google` provider — which needs `@google/genai` and dies with the module-guard error when selected. Scoping
keeps the unusable entries out of the picker. `openai-codex/*` is deliberately absent: that provider
contributes no models until you complete a ChatGPT Plus/Pro OAuth login, and an unmatched pattern warns on
every startup — add it yourself once your subscription models appear.

Credentials — either env vars or interactive OAuth:

```sh
export XAI_API_KEY=…        # or run strape, then: /login xai    (SuperGrok / X Premium)
export OPENAI_API_KEY=…     # or run strape, then: /login openai (ChatGPT Plus/Pro)
export GEMINI_API_KEY=…     # Google AI Studio key
```

### Which providers support OAuth (they differ)

| Provider | API key | OAuth / subscription |
|---|---|---|
| `xai` (Grok) | `XAI_API_KEY` | **yes**, on the same provider — "Sign in with SuperGrok or X Premium" |
| `openai` (plain) | `OPENAI_API_KEY` | no — key only |
| `openai-codex` | — | **yes** — "OpenAI (ChatGPT Plus/Pro)". A *separate provider* from `openai`, so an OAuth login appears under `openai-codex`, not `openai` |
| `gemini-openai` (ours) | `GEMINI_API_KEY` | **no** — see below |

Logging in is `/login <provider>`, typed at the prompt of a **running strape session** — start `strape` first,
then issue the command. `strape auth` is unrelated: it prints an already-configured credential to stdout.

### Gemini and OAuth — asked and answered

**There is no OAuth for the consumer Gemini API.** pi ships no Google OAuth implementation
(`packages/ai/src/auth/oauth/` has anthropic, github-copilot, kimi-coding, openai-codex, openrouter, radius,
xai — no google), and a provider declared in `models.json` can only do API-key auth anyway, because OAuth flows
are wired to built-in provider ids.

Two Google-*account* paths do exist, both through **Vertex AI**, and both were costed rather than assumed:

| Path | How you authenticate | Cost |
|---|---|---|
| Vertex via its OpenAI-compatible endpoint, with `apiKey: "!gcloud auth print-access-token"` | `gcloud auth application-default login` — a real Google-account OAuth flow | **Zero new dependencies.** But `!command` values are cached for the process lifetime (`resolve-config-value.ts:209-214`) while the token lives ~1 h, so any session longer than an hour dies and needs a restart. Also needs a GCP project with billing and Vertex AI enabled |
| pi's built-in `google-vertex` provider with Application Default Credentials | same `gcloud` login; refresh handled properly | Uses `@google/genai` (`api/google-vertex.ts:9`), so it **reverses hunk 4: 56 → 93 shipped packages and 0 → 2 install scripts**. Plus the same GCP project and billing |

**Recommendation: stay on the API key.** It works today, it costs nothing, and for strape's threat model it is
arguably the *better* credential — a Gemini API key is scoped and independently revocable, whereas an OAuth
refresh token carries your Google account session into an `auth.json` whose handling still has open items in
`strape/docs/SECURITY-BACKLOG.md`. If subscription-style auth matters to you, use xAI or OpenAI as the primary
provider; both have real OAuth.

#### Do not try to use a Gemini AI Pro/Ultra subscription from strape

It is technically possible — pi's `pi.registerProvider()` accepts an `oauth` block with a `login()` callback, so
an extension could run Google's OAuth and call the Code Assist endpoint at `cloudcode-pa.googleapis.com` that
`gemini-cli` uses. **Do not.** Google prohibits it and enforces the prohibition:

- The Gemini CLI terms state that accessing the services behind Gemini CLI (including Code Assist) with
  third-party software — for example reusing Gemini CLI's OAuth from another agent — violates their terms.
- Their FAQ describes it as bypassing intended authentication, and grounds for **immediate suspension or
  termination** of the account.
- This has been enforced. Third-party tools proxying that token were banned in February 2026, with reported
  mass suspensions from 25 March 2026 that included **paying Ultra subscribers**.

The reason the token is tempting is also the reason it is restricted: it is first-party, intended for Gemini
CLI / the IDE plugin / Antigravity, and is the only Google token that bills model calls to a consumer
subscription. Anthropic and OpenAI restrict their equivalents the same way.

Consumer Gemini Pro/Ultra is **not** Gemini API access. The supported paths for a third-party agent are an AI
Studio API key or Vertex AI — with Vertex, OAuth and service accounts are fully supported, but *your GCP
project pays* and the subscription is not in the loop.

Watch `google-gemini/gemini-cli` issue #21866, an Ultra subscriber's request for an official third-party OAuth
flow (as OpenAI, MiniMax and Z.AI provide). If Google sanctions one, revisit this — until then the answer is a
paid API key.

`--global` declares the `gemini-openai` provider in `~/.strape/agent/models.json`, pointing at Google's
OpenAI-compatible endpoint. Select `gemini-2.5-pro` or `gemini-2.5-flash` from it. Do **not** pick a Gemini model
from pi's built-in `google` provider — that path needs `@google/genai`, which strape keeps dev-only, so it fails
with a `[strape] blocked module load` message instead of working. The `enabledModels` patterns
`claude-compat --global` writes are provider-scoped precisely so those ~24 unusable entries never reach the
model picker.

Project `CLAUDE.md` needs no configuration. One caveat with teeth: **within a single directory `AGENTS.md`
outranks `CLAUDE.md`**, so a repo containing both will have its `CLAUDE.md` ignored there. Don't keep both.

## 5. Verify the security posture of what you installed

```sh
strape --version                                     # launcher works, offline defaults applied
node strape/scripts/high-scrutiny-check.mjs           # thin-trust packages unchanged
node strape/scripts/sbom.mjs --check strape/audit/sbom-$(cut -d' ' -f1 strape/audit/UPSTREAM_PIN).json
node strape/scripts/fetch-osv.mjs && strape/tools/osv-scanner scan source --lockfile=package-lock.json
npm audit --omit=dev --audit-level=moderate
npm audit signatures --omit=dev                      # needs a real install; lockfile-only cannot verify
```

## Trying it safely first

`strape/sandbox/strape-sandbox --init` runs strape under bubblewrap with the real home hidden, the filesystem
read-only, and credentials confined to a disposable sandbox dir — verified, see `strape/docs/SANDBOX.md`. That
is the recommended way to evaluate it, and to point it at a repository you did not write.

## What strape does *not* give you

No sandbox. Upstream ships none by design, and strape does not add one: the built-in tools run shell commands
and read/write files with the privileges of the process, and prompt injection from repository content is
unmitigated. `PI_OFFLINE=1`, the trimmed dependency closure, and the review gate reduce **supply-chain** risk;
they do nothing about a malicious repo talking the model into running something.

If you need that boundary, containerise the whole process — see
`packages/coding-agent/docs/containerization.md` for upstream's three patterns. Keep
`defaultProjectTrust: "ask"`, and reuse skills you wrote rather than skills you found: skill `allowed-tools`
frontmatter is documented but **not implemented**, so an imported skill is not tool-restricted.
