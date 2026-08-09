# PI-EXTENSION-DECISION

Investigation of sub-agents, workflow orchestration and web access for strape, per
`_output/pi-harness-extension-investigation-handoff.md`.

**Date:** 2026-08-13 · **Against:** strape 0.4.3, upstream pin v0.84.1 · **Shipped closure at time of writing:** 56 packages

---

## 0. The question the brief does not ask, and it changes every answer

The brief was written for stock pi, where "install an extension" means `pi install npm:foo` and the cost is
disk space. The instruction here is to **release these as part of strape**, and strape has a release gate:
every shipped package needs an `allow` verdict plus a matching integrity hash in
`strape/audit/reviewed-deps.json`, or the build fails (CLAUDE.md non-negotiable 2).

So "which package is best" is downstream of **how it is delivered**. There are three models, and they have
wildly different costs:

| Model | Where the code lives | Enters `npm-shrinkwrap.json`? | Review cost |
|---|---|---|---|
| **A. Shipped** — bundled into strape's closure | `packages/coding-agent/npm-shrinkwrap.json` | yes | full per-package review, every package, every sync |
| **B. First-party** — strape-owned extension files | `strape/extensions/*.ts` | no (no new npm deps) | ordinary source review, ours to read |
| **C. User-installed** — `strape install npm:…` at runtime | `~/.strape/npm` | **no** | **none — bypasses the gate entirely** |

Model C is not a loophole to be pleased about. It is the exact hole hunk 9 was written for: extension installs
happen at runtime "for a package that was never in the reviewed closure at all"
(`core/package-manager.ts`, hunk 9 comment). `--ignore-scripts` blunts install-time execution; it does nothing
about the code itself, which is then loaded in-process by jiti with full host privileges. **Anything strape
recommends by name is something strape is implicitly vouching for**, so C is only honest for things we
explicitly label as unreviewed.

Everything below is scored against model A unless stated otherwise, because "released as part of strape" is
what was asked for.

---

## 1. Recommendation

| Area | Choice | Runner-up | Closure cost | Rationale |
|---|---|---|---|---|
| **Sub-agents** | **`@tintinweb/pi-subagents`** (model A, ship it) | DIY on `newSession`/`fork` | **+4** (56 → 60) | Claude Code tool-name parity, MIT, actively published, and the cheapest thing in this entire investigation. Four packages is less than one upstream release usually moves. |
| **Workflows** | **`@quintinshaw/pi-dynamic-workflows`** (model A, ship it) | native skills + subagents only | **+2** (56 → 62 cumulative) | Two packages — itself and `acorn`. Effectively free once subagents are in. |
| **Web access** | **DIY first-party extension** (model B) | curated subset of pi-web-access (+21) | **+0** | `pi-web-access` costs **+119 packages**, ~90 of which polyfill a method Node 22 already has. See §4 — this is the one clear "no". |
| **Bundle** | **Assemble manually** | — | — | `@minhduydev/pi-harness` is a content bundle, not a dependency; see §5. |

Net: **56 → 62 shipped packages (+10.7%)**, plus one strape-owned extension we write and own.

For calibration, strape already rejected the native Gemini SDK at **56 → 93**. That precedent is the yardstick
used throughout this document.

---

## 2. What was verified, and what was not

Being explicit, because the brief asks for hands-on trials and I did not run all of them.

**Verified by execution:**
- Extension API surface, read from the vendored v0.84.1 source: `registerTool`, `registerCommand`,
  `registerFlag`, `registerShortcut`, `registerMarkdownTransformer`, `registerProvider`, **29 hookable
  events**, and session primitives `newSession()`, `fork()`, `sendUserMessage()`, `getSystemPrompt()`.
  Sub-agents are buildable on first-party primitives — this is not a gap that *requires* a third-party package.
- All five candidate packages exist on npm, with current versions and publish dates (§6).
- Transitive closure size for every candidate, measured three times (§6 records the two wrong measurements
  and why, because the method matters more than the number).
- `nanoid@5.1.16` as pulled by pi-subagents is **not** affected by GHSA-2v37-7h3g-55p8 (caps at <5.1.6).
- No candidate has `preinstall`/`install`/`postinstall` scripts — hunk 5's empty allowlist would not fire.

**Not verified — do before committing to model A:**
- Functional behaviour of any package. No agent was spawned, steered, resumed, or nested; no workflow was
  fanned out; no page was fetched. These need a built strape plus provider credentials.
- Context/token overhead per extension. The brief ranks this #3 and I have **no measurement** for it. It is
  the one decision criterion left entirely unevidenced.
- Tool-name collisions between the three picks when loaded together.

The recommendation is nonetheless actionable because it is dominated by closure cost, which *is* measured, and
because the rejections (§4) are decided by numbers rather than by behaviour.

---

## 3. Sub-agents and workflows — ship them

### `@tintinweb/pi-subagents@0.15.0`

```
license   MIT          published 2026-08-10 (created 2026-03-05)
deps      @sinclair/typebox@0.34.52, croner@10.0.1, nanoid@5.1.16
closure   +4 packages, 6.7 MB
scripts   none of preinstall/install/postinstall
repo      github.com/tintinweb/pi-subagents
```

Claude Code parity on tool names (`Agent`, `get_subagent_result`, `steer_subagent`) is decision criterion #1
in the brief, and this is the only candidate that claims it. Four packages is a rounding error against a
56-package closure.

**Two things to look at during review, not blockers:**
- `croner` is a cron scheduler. A subagent manager does not obviously need one — most likely scheduled or
  recurring agents. Worth understanding before signing a verdict, because a cron library implies a background
  timer running in-process.
- `@sinclair/typebox@0.34.x` is a *different package* from the `typebox@1.3.7` strape already ships. Two
  schema libraries in one closure is duplication, not a conflict.

### `@quintinshaw/pi-dynamic-workflows@3.5.1`

```
license   MIT          published 2026-08-05 (created 2026-05-30)
deps      acorn (only)
closure   +2 packages, 3.0 MB
peers     @earendil-works/pi-coding-agent >=0.80.8, pi-tui >=0.80.6, typebox *
```

`acorn` is a JS parser — consistent with a workflow engine that evaluates user-authored scripts. **That is the
security question to ask at review time**: workflow scripts are code, and if they are model-authored, this is
a dynamic-code path into the harness. `capability-sweep.mjs` already classifies `dynamic-code` as its own
capability class; expect this to move that count, and review the delta rather than re-recording it.

Its `typebox: *` peer is satisfied by strape's shipped `typebox@1.3.7`.

**Cheaper alternative worth a moment:** pi has *native* skills, and the brief asks explicitly whether skills +
subagents alone suffice. For strape they largely do — `.claude/skills/` already encodes the review process and
is reused verbatim. If workflow orchestration is not a concrete need today, **defer this pick**; +2 packages
is cheap but not free, and an unused dependency is still a dependency to re-review every sync.

---

## 4. Web access — the one clear rejection

`pi-web-access@0.22.0` is well-maintained (published 2026-08-11) and does the right things functionally. It is
also, measured, **+119 packages / 48 MB**, taking strape from 56 to 175 shipped packages — a **3.1× closure**.

That is more than three times the growth strape already rejected for the native Gemini SDK (56 → 93,
CLAUDE.md non-negotiable 6). Shipping it would mean 119 new per-package verdicts in `reviewed-deps.json`, and
119 packages to re-review at every upstream sync.

**Where the 119 come from — this is the interesting part.** Its declared dependencies are only 8:

```
@mozilla/readability  linkedom  turndown  unpdf  typebox  undici  p-limit  promise.try
```

`typebox` and `undici` strape already ships. And **`promise.try` is a polyfill for `Promise.try`, which has
been native since Node 22** — strape requires Node ≥ 22.19.0, and `node -e "typeof Promise.try"` on the
runtime here returns `function`. That single polyfill drags in `es-abstract` (11 MB) and roughly **90 of the
119 packages**.

So ~75% of the cost is a polyfill for something the runtime already has.

Measured alternative — the extraction essentials alone:

| Option | Packages | Closure after | Verdict |
|---|---|---|---|
| `pi-web-access` wholesale | +119 | 175 | **reject** — 3× the Gemini rejection |
| `readability` + `linkedom` + `turndown` | **+21** | 77 | viable if HTML→markdown fidelity is required |
| DIY on shipped `undici` + `marked`, minimal extraction | **+0** | 56 | **recommended** |
| Search only (API via `fetch`, no extraction) | **+0** | 56 | free — search needs no dependency at all |

**Recommendation: DIY as a first-party extension (model B).**

- **Search** costs nothing: a search API (Brave/Exa/Tavily) is an HTTPS call through `undici`, which strape
  already ships and already hardens (hunk 13's cross-origin redirect guard applies to it automatically,
  because that guard is installed on the *global dispatcher*). API key via env var, no npm dependency.
- **Fetch** is the judgement call. Full readability-grade extraction costs +21 packages; a plain-text
  extraction good enough for most articles costs 0. Start at 0, and only spend the 21 if extraction quality
  measurably blocks real use.

**This is also the option that fits strape's stated posture.** The launcher sets an offline default; adding
web access is a deliberate widening of the threat model, and the widening should be ours to read. A
first-party extension is ~200–300 lines we own, versus 119 packages we do not — the same trade recorded in
HUNKS.md hunk 15, where a 4,546-line parser was *not* vendored precisely because owning it was the larger
burden. Here the arithmetic points the other way: what we would own is small, and what we would import is not.

**One thing to fix regardless:** web fetch retrieves model-influenced URLs and feeds the result back into the
context. That is untrusted input by construction. Whatever ships must (a) run through the hunk-13 dispatcher,
(b) refuse `file://`, `localhost` and link-local/metadata addresses — SSRF into `169.254.169.254` is the
obvious one — and (c) bound response size before it reaches the model. None of that is free in any of the
options above; verify it in `pi-web-access` too if the +21 subset is ever chosen.

### Rejected outright

**`@balaenis/pi-agents@0.4.6` — +183 packages.** Depends on `effect` (the Effect-TS runtime) and
`@agentclientprotocol/sdk`. Larger than the winner by two orders of magnitude for a stated feature set that is
a subset of `pi-subagents`. Apache-2.0, actively maintained, and simply the wrong shape for this closure.

---

## 5. Bundle verdict: assemble manually — and this is the strongest rejection in the document

**Correction (2026-08-13).** An earlier draft of this section called `@minhduydev/pi-harness@2.8.1` "1 package,
4.5 MB, zero runtime dependencies… a content bundle, far less alarming than the brief suggests." That was
measured correctly and concluded wrongly, by the *same* peer-dependency trap described in §6.2. Reading the
installed tarball instead of its dependency count gives the opposite answer.

**What it actually is:**

| | |
|---|---|
| Extensions shipped as source | **21** (`safety`, `rewind`, `checkpoint`, `dcp`, `superpi`, `learning-coordinator`, `herdr-state`, `snap-edit`, `usage-tracker`, `workflow-state`, …) |
| Skills | **65** |
| Agent definitions | 9 |
| npm packages auto-installed **at runtime** via its `settings.json` `packages:` | **7**, from **4 different maintainers** |
| `peerDependencies` | 8, incl. 4 × `@minhduydev/*` — none installed under `--legacy-peer-deps`, which is why the naive count said "0 deps" |
| Upstream pin | `@earendil-works/pi-* >=0.84.0 <0.85.0` — hard-coupled to one upstream **minor** |

Three findings, each independently disqualifying for strape:

1. **It violates the brief's hard constraint.** `.pi/extensions/safety/` is a permission-gate extension —
   `rules/` contains `credentials.ts`, `destructive.ts`, `git.ts`, `injection.ts`, `network.ts`, `publish.ts`,
   `system.ts`, `workspace.ts`, plus `evaluate.ts`/`compose.ts`/`audit.ts`. The brief says permission-gate
   extensions must be excluded or disabled, and `settings.json` exposes no knob to disable it (top-level keys
   are `packages`, `pi-learning`, `pi-todo`, `compaction`, `branchSummary`, `retry`, `steeringMode`,
   `followUpMode`, `enableSkillCommands`, `pi-harness`). Removing it means editing files inside someone
   else's package on every update.
2. **It installs seven more packages at runtime, outside every gate strape has.** Its `settings.json` declares
   `packages: [@minhduydev/pi-core, pi-subagents, pi-todo, pi-learning, @heyhuynhgiabuu/pi-search,
   @sting8k/pi-srcwalk, @mrclrchtr/supi-ask-user]`. Those install into `~/.strape/npm` through the runtime
   path — pinned versions, to the author's credit, but **never entering `npm-shrinkwrap.json`, never getting a
   `reviewed-deps` verdict, never appearing in the SBOM.** Adopting the bundle means adopting a supply chain
   from four maintainers that strape's release gate cannot see. This is precisely the hole hunk 9 documents.
3. **It pins to one upstream minor.** `>=0.84.0 <0.85.0` matches strape's current pin today and breaks the
   day upstream reaches 0.85, until the author republishes. That inverts strape's control of its own sync
   cadence — decision criterion #2, in the wrong direction.

**Verdict: assemble manually.** Take `@tintinweb/pi-subagents` (+4) and, if needed,
`@quintinshaw/pi-dynamic-workflows` (+2) as *individual, reviewable* dependencies, and write web access
first-party. Six packages we choose and review beats 21 extensions, 65 skills and 7 unreviewed runtime
installs we did not.

None of this is a criticism of the bundle. It is a genuinely rich, carefully-pinned piece of work aimed at a
user who wants a batteries-included pi. strape is the opposite proposition — its entire value is that
somebody read what ships — and the two goals are incompatible by construction, not by quality.

Worth reading as a **reference** for config patterns and its 9 agent definitions — as is
`disler/pi-vs-claude-code` — without installing.

---

## 6. Trial notes appendix

### 6.1 Registry facts (npm, 2026-08-13)

| Package | Latest | Published | Created | License | Direct deps | Install scripts |
|---|---|---|---|---|---|---|
| `@tintinweb/pi-subagents` | 0.15.0 | 2026-08-10 | 2026-03-05 | MIT | 3 | none |
| `@quintinshaw/pi-dynamic-workflows` | 3.5.1 | 2026-08-05 | 2026-05-30 | MIT | 1 | none |
| `pi-web-access` | 0.22.0 | 2026-08-11 | 2026-01-27 | MIT | 8 | none |
| `@balaenis/pi-agents` | 0.4.6 | 2026-08-08 | 2026-07-22 | Apache-2.0 | 2 | none |
| `@minhduydev/pi-harness` | 2.8.1 | 2026-08-08 | 2026-07-27 | MIT | 0 | none |

All five are alive and were published within a week of investigation — maintenance health (criterion #2) is
not a differentiator here. The scope rename the brief warns about is already reflected: every package peers
on `@earendil-works/pi-*`, not `@mariozechner/*`.

### 6.2 How the closure numbers were obtained — and got wrong twice

Recorded because the method is the transferable part, and because this repo has been burned by an unchecked
measurement before (the grok-mermaid line count was 3× wrong).

**Attempt 1 — wrong.** Plain `npm install <pkg>` reported 109–421 packages and 313–418 MB for everything,
including 109 packages for a package with 3 dependencies. Cause: every candidate declares
`@earendil-works/pi-*` as **peerDependencies**, and npm ≥7 auto-installs peers, pulling an entire second copy
of pi. Pi's own installer avoids exactly this — `getNpmInstallArgs` passes `--legacy-peer-deps` so package
managers "do not install or solve host-provided `@earendil-works/pi-*` peers" (`core/package-manager.ts`).
**Measuring an install without the flags the real installer uses measures a scenario that never happens.**

**Attempt 2 — still wrong.** Re-ran with `--legacy-peer-deps --ignore-scripts`, deleting `node_modules` and
the lockfile between packages. Numbers climbed monotonically (6 → 9 → 126 → 135 → 137) and later packages
listed earlier candidates as dependencies. Cause: `npm install X` **appends X to `package.json`**, so each
install carried all previous ones. Deleting `node_modules` does not undo that.

**Attempt 3 — correct.** A fresh directory and a fresh `package.json` per package, then
`npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --omit=dev`:

| Package | Transitive packages | Size |
|---|---|---|
| `@quintinshaw/pi-dynamic-workflows` | 2 | 3.0 MB |
| `@tintinweb/pi-subagents` | 4 | 6.7 MB |
| `@minhduydev/pi-harness` | 1 † | 4.5 MB |

† **Misleading — see §5.** All four of its `@minhduydev/*` peers go uninstalled under `--legacy-peer-deps`, and
its real payload is 21 bundled extensions plus **7 packages it installs at runtime from its own
`settings.json`**. A dependency count is the wrong instrument for a bundle; read the tarball.
| `pi-web-access` | **119** | 48 MB |
| `@balaenis/pi-agents` | **183** | 45 MB |
| *(readability + linkedom + turndown only)* | *21* | *16 MB* |

### 6.3 Extension API, from the vendored source

`packages/coding-agent/src/core/extensions/types.ts` (1,727 lines) exposes `registerTool`, `registerCommand`,
`registerFlag`, `registerShortcut`, `registerMarkdownTransformer`, `registerProvider`, and 29 events:

```
project_trust  resources_discover  session_start  session_info_changed  session_before_fork
session_before_tree  session_tree  session_compact  session_shutdown  context  input
before_provider_headers  after_provider_response  before_agent_start  agent_start  agent_end
agent_settled  turn_start  turn_end  message_start  message_update  message_end
tool_call  tool_result  tool_execution_start  tool_execution_update  tool_execution_end
model_select  thinking_level_select  user_bash
```

Plus session control: `newSession()`, `fork()`, `switchSession()`, `navigateTree()`, `sendUserMessage()`,
`compact()`, `getSystemPrompt()`, `getContextUsage()`.

The relevant conclusion: **a subagent implementation is buildable on these primitives**, so
`@tintinweb/pi-subagents` is a convenience-and-parity purchase, not a capability strape could not otherwise
have. That matters for criterion #6 (escape hatch) — if it is abandoned, reimplementing is bounded work
against a documented API, not a rewrite.

---

## 7. Install plan

**Do not run this yet.** Each step is a dependency-review event; the gate will fail until verdicts exist,
and that failure is the gate working (CLAUDE.md non-negotiable 2).

### Step 1 — decide the delivery model per area (blocking, human)

Nothing below is safe to execute until §0's model A/B/C choice is recorded. Shipping means these packages
enter `npm-shrinkwrap.json` and need verdicts.

### Step 2 — sub-agents and workflows into the shipped closure

```sh
# Add to packages/coding-agent/package.json dependencies, then regenerate — never hand-edit the shrinkwrap:
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent

# The gate will now FAIL with 6 unreviewed packages. That is correct. Review them:
#   .claude/skills/dep-review          (tarballs, not the GitHub repos)
node strape/scripts/reviewed-deps.mjs --report
```

Expected new verdicts: `@tintinweb/pi-subagents`, `@sinclair/typebox`, `croner`, `nanoid`,
`@quintinshaw/pi-dynamic-workflows`, `acorn`.

### Step 3 — regenerate every pin-named baseline

```sh
node strape/scripts/capability-sweep.mjs --check strape/audit/capability-sweep-v0.84.1.json   # READ the delta
node strape/scripts/sbom.mjs
node strape/scripts/dep-health.mjs   --json strape/audit/dep-health-v0.84.1.json
node strape/scripts/provenance.mjs   --json strape/audit/provenance-v0.84.1.json
node strape/scripts/guarddog-scan.mjs --json strape/audit/guarddog-v0.84.1.json
```

Pay attention to the **capability sweep delta**, especially `dynamic-code` (acorn) and `process-exec`
(subagent spawning). Those are the classes that should move; anything else moving is a question.

### Step 4 — configuration

Pi splits loading from exposure: `extensions:` controls what loads, `tools:` controls what the model sees.

```jsonc
// ~/.strape/settings.json  — seeded by strape/scripts/claude-compat.mjs
{
  "extensions": ["@tintinweb/pi-subagents", "@quintinshaw/pi-dynamic-workflows"],
  "tools": ["Agent", "get_subagent_result", "steer_subagent"]
}
```

Keep `tools:` explicit. Every exposed tool is system-prompt tokens on every request, and criterion #3 is
minimal context overhead — which, per §2, nobody has measured yet.

### Step 5 — web access, first-party

`strape/extensions/web.ts`, registering `web_search` and `web_fetch`, using the already-shipped `undici`.
Requirements from §4 are not optional: hunk-13 dispatcher, scheme/host denylist for `file://`, `localhost`,
link-local and cloud metadata, and a response size bound. Needs its own regression test in
`strape/scripts/`, in the style of `redirect-guard-test.mjs`.

```sh
export BRAVE_API_KEY=...     # or EXA / TAVILY; never on argv
```

### Step 6 — re-sign

Steps 2 and 3 change `packages/**` and the shrinkwrap, both inside the attestation digest:

```sh
node strape/scripts/review-attest.mjs --record --by "Your Name" --date 2026-..-..
```

---

## 8. Risks and watch items

| Risk | Assessment |
|---|---|
| **Context overhead unmeasured** | Criterion #3, no data. Measure `getContextUsage()` / `getSystemPrompt()` length with 0, 1 and 2 extensions loaded **before** committing. |
| **`acorn` = dynamic code execution** | Workflow scripts are code. If model-authored, this is a new dynamic-code path. Review what `pi-dynamic-workflows` evaluates and in what context. |
| **`croner` in a subagent manager** | An in-process scheduler is a background timer. Understand why it is there before signing the verdict. |
| **Three single-maintainer packages** | All young (created 2026-03 to 2026-07). Register all six new packages in `strape/audit/high-scrutiny.json` so a version move fails the build. |
| **Peer-dependency drift** | Each peers on `@earendil-works/pi-* >= 0.80`. An upstream bump could break them silently, or npm could resolve peers differently than pi does. Re-check at every sync. |
| **Extensions run in-process with full privileges** | jiti loads them into the host (hunk 14 already moved that transpile cache out of `/tmp`). `allowed-tools` in skill frontmatter is documented by upstream but **not implemented** — there is no sandbox here. |
| **Web fetch is untrusted input** | Model-influenced URLs, response fed back into context. SSRF and prompt-injection surface. The mitigations in §4 are requirements, not nice-to-haves. |
| **Closure re-review cost compounds** | +6 packages is +6 tarballs to review at every sync, forever. Cheap now, recurring later. |

---

## 9. Recommended sequencing

1. **Measure context overhead** (§2 gap) — it can still change the answer, and it is the cheapest missing input.
2. **Ship sub-agents alone** first. +4 packages, highest value, clearest Claude Code parity. One dependency
   review, one baseline regeneration, one re-sign.
3. **Defer workflows** until there is a concrete workflow to run. Native skills may already cover it, and an
   unused dependency still costs a review every sync.
4. **Write web access first-party**, starting with search (+0 packages) and plain fetch. Spend the +21
   extraction packages only if quality demonstrably blocks real work.
5. **Do not adopt any bundle.**
