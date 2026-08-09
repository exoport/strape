# strape research record

Why these files exist: strape is a fork of someone else's actively developed codebase, adopted for security
reasons. Every decision here was made against verified evidence, and that evidence expires — upstream ships
2-5 releases a week. This directory is what lets the next person (or the next agent) re-verify a decision
instead of re-deriving it, and see which claims were later disproved.

Investigation dates: **2026-08-06**. Upstream baseline: **pi `v0.84.0`**
(`a5f43bf8aff3c55752432655f7334e3dafd1e256`).

## Read in this order

| File | Answers |
|---|---|
| [01-pi-architecture.md](01-pi-architecture.md) | What pi is made of, what ships, how it builds, and where "pi" is hardcoded |
| [02-claude-compat-and-providers.md](02-claude-compat-and-providers.md) | Can we reuse `CLAUDE.md` and `.claude/skills`? Do Grok and OpenAI work? |
| [03-dependency-security-baseline.md](03-dependency-security-baseline.md) | What supply-chain controls pi already has, what strape's trim achieved, what risk remains |
| [04-upstream-health-and-licensing.md](04-upstream-health-and-licensing.md) | Is this project safe to depend on and legal to rebrand? What has gone wrong before? |
| [05-design-alternatives.md](05-design-alternatives.md) | The decision record: two competing designs, the conflicts, and how each was resolved |
| [06-security-review-methodology.md](06-security-review-methodology.md) | **How the review is actually run** with tooling + Claude Code, and what it costs |
| [07-build-and-verification-log.md](07-build-and-verification-log.md) | What was executed on 2026-08-06 and what the commands actually returned |
| [08-security-review-findings.md](08-security-review-findings.md) | **What the review found**, what was fixed, what is accepted risk, and where the review fell short |
| [raw/](raw/) | Unedited structured output from the seven research agents, for provenance |

The implementation lives in a separate git repo: `../strape/` (branches `vendor` and `main`). Its
`strape/docs/HUNKS.md` is the authoritative record of divergence, and `strape/audit/` holds the gate files.
The original proposal is `../strape-proposal.md`.

## The four conclusions

1. **Rename to strape: worth it, ~7 lines.** `piConfig {name, configDir}` plus `bin` in one `package.json` is
   an upstream-designed fork seam (`config.ts:487-496`); it derives the app name, config dir, agent dir and
   env-var prefixes automatically. Verified in the built binary: help output is fully rebranded with zero
   `.pi` paths remaining. The npm scope was deliberately **not** renamed (~469 files, no benefit for a fork
   that never publishes).
2. **Claude Code compatibility: free.** Project `CLAUDE.md` is already a built-in context-file candidate
   (`resource-loader.ts:71`); `.claude/skills` reuse is one settings key per scope. Two caveats that matter:
   `AGENTS.md` outranks `CLAUDE.md` within the same directory, and skill `allowed-tools` frontmatter is
   documented but **not implemented**, so imported skills are not tool-restricted.
3. **The dependency trim is the highest-leverage security change.** Moving five unused provider SDKs to
   `devDependencies` took the shipped closure from **143 to 56 packages** and install-script packages from
   **2 to 0**, with no lockfile regeneration and no broken imports. Five lines.
4. **Maintainability comes from smallness.** Six hunks, additive overlay, merge (never rebase), and an
   invariant checker that fails CI if a merge reverts a hunk.

## The review paid for itself

It found three issues serious enough to fix in code, so **three of strape's nine divergence hunks are security
fixes the review produced** — not branding or dependency work. Details in
[08](08-security-review-findings.md); the two with CVE-shaped write-ups are in `../strape/audit/`.

1. **A symlinked project `CLAUDE.md` reads any file the user can read** and ships it to the model provider,
   with no trust prompt (`statSync` follows symlinks). This sits *inside* strape's headline compatibility
   feature — adopting `CLAUDE.md` reuse without the fix would have shipped the vulnerability as a selling
   point. Reproduced, fixed (hunk 8), CI-pinned. `STRAPE-2026-002`.
2. **Runtime extension/skill installs ran npm lifecycle scripts.** `grep -c "ignore-scripts"` over
   `core/package-manager.ts` returned 0, so the careful build-time posture was only half a control. Fixed in
   all four install paths (hunk 9).
3. **An untrusted repo could redirect the session transcript** by setting `sessionDir` in project settings that
   are merged before the trust decision. Reproduced end-to-end, fixed using the persisted trust decision so
   trusted projects keep the feature (hunk 7). `STRAPE-2026-001`.

Plus a supply-chain path **outside npm entirely**: pi resolves `ripgrep`/`fd` versions from GitHub's
latest-release API at runtime and executes the downloaded binaries with no checksum, signature, or pinned
version (`utils/tools-manager.ts:108-123`, `:265-271`). Because these are not npm packages, the lockfile,
shrinkwrap hashes, SBOM, `npm audit`, `osv-scanner` and the reviewed-deps gate all rate the project clean
while a fresh install fetches and runs unverified native binaries on first `grep`. Answered by
`strape/scripts/provision-tools.mjs` (pinned, sha256-verified, refuse-on-mismatch) plus `PI_OFFLINE=1`.

## Status, stated plainly

The security **infrastructure** is built, executed, and tested in both directions — every gate was verified to
fail, not just to pass. The security **review** is not signed off: all 50 dependency entries carry
`reviewedBy: null`, 26 are `escalate`, and the build gate **fails on purpose**. Agent output is evidence for a
human decision, never the decision. Nothing here should be read as "strape has passed a security review".

Two things to carry forward honestly. Session rate limits killed 16 of Job A's 66 agents, so one first-order
area (`tool-fs` path containment) was never reviewed and 14 findings never got adversarial verification. And
because fixes were applied while the review was still running, two verifiers "refuted" a real finding on the
grounds that the code no longer existed — correct about the tree, wrong about the vulnerability. Freeze the
tree during a review pass, or re-verify after fixing. Both limitations are detailed in
[08](08-security-review-findings.md).
