# Claude Code Compatibility and OpenAI/xAI Provider Support in pi

This file answers two questions: (1) exactly how does pi discover and load `CLAUDE.md` context files and
`.claude/skills` directories, including the precedence rules, gaps, and the one configuration mistake to
avoid; and (2) how mature and complete is pi's OpenAI and xAI (Grok) provider support, and what would be
involved in dropping Anthropic/Google/AWS/Mistral. Evidence is drawn from `01-compat-providers.json` (a
direct code audit with file:line citations), cross-checked against `04-architecture-rename.json` and
`06-design-security-first.json` (which independently re-verified several of the same claims by actually
loading resources through the SDK, not just reading code), and re-verified in this pass against the `pi/`
upstream mirror on disk. Distinctions between "verified by reading code," "verified by running/loading
through the SDK," and "documented but unverified" are preserved from the source reports.

## 1. CLAUDE.md discovery

### 1.1 Candidate list and precedence (verified by reading code; re-verified in this pass)

`packages/coding-agent/src/core/resource-loader.ts`, function `loadContextFileFromDir()`:

```ts
const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
```

(cited as `resource-loader.ts:71` by 04/05/06/proposal, and as `resource-loader.ts:70-89` by
01-compat-providers.json — both point at the same array; the small line-number spread across reports
reflects independent read passes, re-confirmed at line 71 in this pass against the `pi/` mirror.)

The function iterates the candidates **in this fixed order** and returns the **first existing file**,
immediately, per directory. Consequences:

- If a single directory has **both** `AGENTS.md` and `CLAUDE.md`, `AGENTS.md` always wins in that
  directory; `CLAUDE.md` is only used when no `AGENTS*.md` variant exists there.
- This precedence is **hardcoded** — not configurable via `settings.json`, an environment variable, or a
  CLI flag. The only lever is the all-or-nothing `--no-context-files`/`-nc` flag (SDK option
  `noContextFiles`), documented at `packages/coding-agent/src/cli/args.ts:287` and wired at
  `resource-loader.ts:172,515-521`, which disables *all* context-file loading, not just reordering.
- Changing the per-directory resolution order requires editing the `candidates` array in source. All three
  design passes (05, 06) and the final proposal considered this a legitimate but low-priority "seventh
  hunk" candidate and **explicitly rejected adding it**: `strape/docs/HUNKS.md` records it as a "known
  candidate, currently rejected... cheaper to not keep both files in the same directory. Revisit if teams
  hit it."

### 1.2 Directory-walk (ancestors) plus a separate global file

`loadProjectContextFiles()` (`resource-loader.ts:118-156`, re-verified in this pass at these exact lines)
does two things:

1. Loads **one global context file** from `agentDir` (default `~/.pi/agent`, becomes `~/.strape/agent`
   after the rename) via the same candidate list, once, before any per-directory walk.
2. Walks from `cwd` up to the filesystem root via a `dirname()` loop that terminates when
   `parentDir === currentDir`, loading **at most one context file per directory**, and orders the results
   ancestors-first, cwd's-own-file-last (`ancestorContextFiles.unshift(...)` per iteration, then appended
   after the global file).

A companion function, `findShadowedContextFile()` (`resource-loader.ts:100-116`), prevents double-loading a
linked git worktree's own context file when it duplicates the main repo's — handling the case where
`git worktree add` creates a second working directory whose ancestor walk would otherwise re-load the same
logical file twice.

**Practical result:** project-level `CLAUDE.md` files are picked up automatically with **zero
configuration** — no fork, no settings change. This was independently re-verified by loading resources
through the actual SDK (not just reading source) in 06-design-security-first.json's `claude_compat_plan`:
"`loadProjectContextFiles({cwd, agentDir})` on a test project returned `<proj>/CLAUDE.md`" and, after
adding a symlink, "the same call then returned BOTH `<agentDir>/CLAUDE.md` and `<proj>/CLAUDE.md`, in that
order."

### 1.3 The global-CLAUDE.md gap

pi's global fallback only checks `<agentDir>/CLAUDE.md` (default `~/.pi/agent/CLAUDE.md`,
`resource-loader.ts:128`) — **not** Claude Code's `~/.claude/CLAUDE.md`. There is no code path that
reads `~/.claude` directly. A user who relies on a global (all-projects) `CLAUDE.md` from Claude Code needs
a one-time symlink or copy step:

```sh
ln -sfn ~/.claude/CLAUDE.md ~/.strape/agent/CLAUDE.md
```

All three raw reports (01, 04, and both design passes) agree on this gap and this fix; there is no
disagreement here. This is the one piece of the "reuse Claude Code files" goal that does **not** work with
zero configuration — everything else (project `CLAUDE.md`, project skills, global skills) does.

## 2. `.claude/skills` reuse

### 2.1 What's auto-scanned vs. what needs a settings entry

Skills discovery (`packages/coding-agent/src/core/skills.ts` + `package-manager.ts`) auto-scans, with no
configuration:

- `<agentDir>/skills` (default `~/.pi/agent/skills`)
- `<cwd>/<CONFIG_DIR_NAME>/skills` (default `.pi/skills`, `resource-loader.ts:818-821`, re-verified in this
  pass at these lines)
- A harness-neutral convention, `.agents/skills`, walked from cwd up to the git repo root (or filesystem
  root), plus `~/.agents/skills` globally (`package-manager.ts:435` `collectAncestorAgentsSkillDirs`,
  `package-manager.ts:2378` `addAutoDiscoveredResources` in this pass's re-verification; cited as
  `package-manager.ts:2375-2478` by 01-compat-providers.json and as `package-manager.ts:442/2375/2415/2466`
  and `trust-manager.ts:186/195` by 04-architecture-rename.json — the small numeric spread across reports
  reflects different functions/call sites within the same feature, not a contradiction).

**`.claude/skills` is not in this auto-scanned list.** It must be added explicitly via the `skills` array
in `settings.json`, at whichever scope is needed:

| Scope | File | Setting |
|---|---|---|
| Global | `~/.strape/agent/settings.json` | `{"skills": ["~/.claude/skills"]}` |
| Per-project | `<repo>/.strape/settings.json` | `{"skills": ["../.claude/skills"]}` |

This is officially documented by upstream, not a workaround: `packages/coding-agent/docs/skills.md`
("Using Skills from Other Harnesses," lines ~43-62, re-verified verbatim in this pass) shows exactly this
pattern, including a Codex example (`~/.codex/skills`). `docs/settings.md:239-248` documents the same
`skills`/`extensions`/`prompts`/`themes` string[] resource-override settings, supporting `~`, globs, and
`!`/`+`/`-` include/exclude prefixes.

### 2.2 Path resolution bases (verified by reading code; re-verified in this pass)

`package-manager.ts:903-904`:

```ts
const globalBaseDir = this.agentDir;                       // ~/.strape/agent
const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);    // <repo>/.strape
```

So a relative path in **project** settings resolves against `<repo>/.strape`, meaning `../.claude/skills`
in `<repo>/.strape/settings.json` correctly resolves to `<repo>/.claude/skills` — confirmed both by static
code reading (proposal §4.3) and by dynamically creating a real skill and loading it through
`DefaultResourceLoader` in 06-design-security-first.json: "I created `<proj>/.claude/skills/demo-skill/
SKILL.md`... and `DefaultResourceLoader` + `await reload()` reported `{name: "demo-skill", path:
"<proj>/.claude/skills/demo-skill/SKILL.md"}` with zero diagnostics." That report also flags a real gotcha:
`reload()` must be awaited — `getSkills()` returns `[]` before it.

### 2.3 Format compatibility: Claude Code `SKILL.md` files work unmodified

A directory containing `SKILL.md` is a skill root and is not recursed further (`skills.ts:160-171,
194-221`) — identical to Claude Code's convention. Required frontmatter fields are `name` (lowercase,
a-z0-9-hyphen, ≤64 chars) and `description` (required, ≤1024 chars). Unlike the wider Agent Skills spec, pi
does **not** require `name == parent-directory-name` (`skills.ts:296-301`, `docs/skills.md:143,157`) —
deliberately lenient, per the docs, "for shared skill directories used across multiple agent harnesses."
Unknown frontmatter fields are silently ignored (`docs/skills.md:184`). pi additionally auto-registers
every skill as a `/skill:name` slash command that appends user args ("User: <args>", `docs/skills.md:82`)
— a pi-specific addition, not a compatibility gap.

## 3. The `allowed-tools` gap: documented, not implemented

`docs/skills.md:148` lists `allowed-tools` as a skill frontmatter field: "Space-delimited list of
pre-approved tools (**experimental**)." A `grep -rn "allowed-tools" packages/coding-agent/src` returns
**zero hits** (verified in 01-compat-providers.json and independently re-confirmed by
06-design-security-first.json's audit pass). The field is parsed as an unknown/ignored frontmatter key —
it does nothing. **Any strape security model that assumes skills are tool-restricted via `allowed-tools`
would be a false sense of security**; a skill can invoke any tool regardless of what it declares. This is
carried into the shipped strape repo's own `CLAUDE.md` as an explicit non-negotiable: reuse only skills you
wrote, not skills you found, and keep `defaultProjectTrust: "ask"`.

Related: upstream's `docs/security.md` states that context files (`AGENTS.md`/`CLAUDE.md`) "load regardless
of trust status" — trust gates extensions and skills, but not context-file content. Both context files and
skill content are named by upstream's own `SECURITY.md` as an unmitigated prompt-injection vector.

## 4. Why `configDir` must never be `.claude`

`CONFIG_DIR_NAME` is read once at import time from `packages/coding-agent/package.json`'s
`piConfig.configDir` field (`config.ts:491`) — a build-time constant, not overridable by env var or
`settings.json` at runtime. If it were set to `.claude` instead of a fork-specific name, two collisions
follow, both independently identified by every raw report that considered it (01, 02, 04, 05, 06):

1. **Project settings collide.** `settings-manager.ts:201` computes project settings as
   `join(cwd, CONFIG_DIR_NAME, "settings.json")`. With `configDir: ".claude"` this becomes
   `<repo>/.claude/settings.json` — **the exact path and filename Claude Code itself uses** for its own
   project settings, but with an incompatible schema. This could silently corrupt, or be corrupted by,
   Claude Code's own project configuration in any repo used with both tools.
2. **Global agent state collides.** The agent root becomes `~/.claude/agent/`, writing `auth.json`,
   `trust.json`, `models.json`, and sessions inside the user's real `~/.claude` directory — a
   shared-namespace dependency where a future Claude Code release adding its own files there, or a strape
   upgrade changing what it writes, could collide (02-pi-dev-upstream.json risks #1).

The unanimous resolution across every raw report and the shipped repo: use a fork-specific `configDir`
(strape used `.strape`) and make Claude Code reuse purely **additive** — via the `skills` settings array
and a `CLAUDE.md` symlink — never by aliasing pi's own config root onto `.claude`. This rule is recorded
verbatim as non-negotiable #4 in the shipped `strape/CLAUDE.md`.

## 5. OpenAI and xAI provider support

### 5.1 Provider definitions (verified by reading code; re-verified in this pass)

**OpenAI** (`packages/ai/src/providers/openai.ts`, re-verified in full in this pass):

```ts
export function openaiProvider(): Provider<"openai-responses"> {
  return createProvider({
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: Object.values(OPENAI_MODELS),
    api: openAIResponsesApi(),
  });
}
```

OpenAI uses only the **Responses API** (not legacy Chat Completions), and also supports ChatGPT Plus/Pro
OAuth login in addition to `OPENAI_API_KEY` (`docs/providers.md`, cited by 02-pi-dev-upstream.json
key_facts #19).

**xAI** (`packages/ai/src/providers/xai.ts`, re-verified in full in this pass):

```ts
export function xaiProvider(): Provider<"openai-completions" | "openai-responses"> {
  return createProvider({
    id: "xai",
    baseUrl: "https://api.x.ai/v1",
    auth: {
      apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]),
      oauth: lazyOAuth({ name: "xAI (Grok/X subscription)", isSubscription: true,
        loginLabel: "Sign in with SuperGrok or X Premium", load: loadXaiOAuth }),
    },
    models: Object.values(XAI_MODELS),
    api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi() },
  });
}
```

xAI registers **both** the `openai-completions` and `openai-responses` APIs and needs no dedicated SDK — it
rides the shared `openai` npm client via `openai-completions.ts`'s `provider === "xai"` special-casing
(`isGrok = provider === "xai" || baseUrl.includes("api.x.ai")`). Auth is `XAI_API_KEY` **or** OAuth
subscription login ("Sign in with SuperGrok or X Premium," documented at `docs/providers.md:42-45`,
`/login xai`).

### 5.2 Per-model API assignment for Grok

`packages/ai/scripts/generate-models.ts:1608-1635` (build-time catalog generator): only `grok-4.5`
(`XAI_RESPONSES_MODEL_ID`) uses the Responses API, with a custom effort-level map
(`XAI_RESPONSES_EFFORT_LEVEL_MAP`) and `supportsLongCacheRetention: false`. Every other tool-calling Grok
model uses `openai-completions` (models where `m.tool_call !== true` are filtered out of the catalog
entirely). Older/non-reasoning variants — `grok-3`, `grok-3-fast`, `grok-4.20-*-non-reasoning`,
`grok-code-fast-1` — are excluded from the built-in catalog altogether
(`XAI_BUILTIN_EXCLUDED_MODEL_IDS`).

xAI gets one xAI-specific plumbing detail in the shared Responses-API client: for `model.provider ===
"xai"`, `params.include = ["reasoning.encrypted_content"]` (`packages/ai/src/api/openai-responses.ts:327`)
— a small special case in otherwise-shared code, not a fork.

### 5.3 Symmetric default-model treatment

`packages/coding-agent/src/core/model-resolver.ts:20-40`'s `defaultModelPerProvider` table treats
`openai` (`gpt-5.5`) and `xai` (`grok-4.5`) as first-class defaults on **equal footing** with `anthropic` —
this is product-level support, not an afterthought grafted onto an Anthropic-first product.

### 5.4 What's droppable, what's inert

**Statically imported but lazy-loaded at runtime.** `packages/ai/src/providers/all.ts` statically
`import`s every provider module, including `anthropic-messages.ts` (`@anthropic-ai/sdk`),
`bedrock-converse-stream.ts` (`@aws-sdk/client-bedrock-runtime`, `@smithy/node-http-handler`),
`google-*.ts` (`@google/genai`), and `mistral-conversations.ts` (`@mistralai/mistralai`), and
`builtinProviders()` unconditionally constructs all ~40 providers into one array (re-verified in this pass:
`builtinProviders()` at `all.ts:89-129` still lists `anthropicProvider()`, `googleProvider()`,
`mistralProvider()`, `amazonBedrockProvider()` unmodified in the shipped strape repo).

This is where the raw reports **initially disagreed, and one design pass corrected the other**:

- **01-compat-providers.json** (an earlier pass) characterized this as "these SDKs load into memory... even
  for a Grok/OpenAI-only deployment," implying static loading was a real runtime cost.
- **05-design-minimal-effort.json** explicitly flagged this as a premise correction: "I corrected a
  research premise: the heavy SDKs are **not** loaded at startup —
  `packages/ai/src/api/*.lazy.ts` wrap them in `lazyApi(() => import(...))`, so trimming them is safe and
  only fails if an Anthropic/Bedrock/Google/Mistral model is actually invoked."
- **06-design-security-first.json** went further and ran upstream's own test suite as proof: "upstream's
  own `packages/ai/test/lazy-module-load.test.ts` asserts that importing the root barrel, building all
  builtin providers, and calling `getModels()` load ZERO provider SDKs. I ran it: 5/5 passing."

The resolved understanding, carried into the shipped implementation: the SDKs are **lazily loaded**
(`packages/ai/src/providers/anthropic.ts:1` imports `../api/anthropic-messages.lazy.ts`, not the SDK
directly), so leaving `builtinProviders()` untouched is safe from a startup-execution standpoint. But they
still **ship on disk** as production dependencies unless removed from `package.json`, which is a real
install-footprint and review-surface cost even though it's not a runtime-execution cost — this distinction
(disk presence vs. execution) is the central argument resolved in
`strape/research/05-design-alternatives.md`. strape's actual fix was to move the five SDKs from `dependencies` to
`devDependencies` in `packages/ai/package.json` (leaving `providers/all.ts` completely untouched) — so
Anthropic/Google/Mistral/Bedrock models still **appear in the catalog** (nothing in `all.ts` removes their
registration) but **fail at stream time with a module-resolution error** in a production
(`--omit=dev --ignore-scripts`) install, since the SDK is no longer present. `enabledModels` in
`settings.json` hides them from the picker as a UX/soft measure on top of that hard failure mode.

**Inert constants that are safe to leave:** `cacheControlFormat: "anthropic"` (`model-config.ts:99,123`,
a literal cache-header-format string, not a live dependency), Anthropic/Bedrock default model IDs in
`model-resolver.ts:21,23`, an opt-out warning `warnings.anthropicExtraUsage` for subscription
extra-usage billing, and Anthropic-specific image-resize limits (`utils/image-resize-core.ts`). None of
these blocks removing or hiding the Anthropic provider; they were explicitly left alone by the proposal
as "cheap, all upstream-mergeable."

**Not used for provider removal:** `pi.unregisterProvider()` is a real extension API
(`docs/custom-provider.md:188-190`) but only removes **extension-registered** providers — it cannot remove
a builtin (`packages/coding-agent/src/core/model-runtime.ts:780-786`, per
05-design-minimal-effort.json's pros list). strape does not rely on it; the dependency-trim approach (§5.4
above) is the actual mechanism.
