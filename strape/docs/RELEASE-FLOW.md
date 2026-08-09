# Release flow: what runs in CI, what runs locally, and why

## The constraint that decides everything

strape exists so that we control our own release gate: we decide which upstream tag we run, and we decide it
after looking at what changed. That review needs an LLM, provider credentials, and human judgment, and none of
those belong in CI — handing provider keys to a CI job so it can approve its own build would put the decision
back in the pipeline, which is the thing we set out to own.

But a local-only review leaves a hole. CI runs the deterministic gates and goes green with **no idea whether
anyone reviewed the code it just blessed**. Merge an upstream release, regenerate the baselines — a legitimate
step — and every gate passes with zero review.

So the split is not "some checks here, some there". It is:

> **Local does the judging. CI proves the judging happened, and that nothing has changed since.**

`strape/scripts/review-attest.mjs` is what makes the second half true. It digests the reviewed scope (in-scope
first-party source + the generated shrinkwrap + the hunk-bearing files) and binds a named sign-off to that
digest. Change a reviewed file and CI fails with *re-review required* instead of shipping. CI can never write
that file — only a human on a local machine can.

## The flow: GitHub → local → GitHub

```
  ┌─ GitHub (CI) ──────────┐   ┌─ Local (human + LLM) ────┐   ┌─ GitHub (CI) ─────────┐
  │ 0. detect              │   │ 1. scope                 │   │ 3. verify             │
  │    daily scanners       │──▶│    sync.mjs --target     │──▶│    PR: every gate +   │
  │    say "upstream moved" │   │ 2. review + fix + sign   │   │    attestation match  │
  │    or "a dep drifted"   │   │    skills, then attest   │   │ 4. release on tag     │
  └────────────────────────┘   └──────────────────────────┘   └───────────────────────┘
```

Your instinct was right: **start in GitHub, go local, finish in GitHub.** The reason is that detection is
mechanical (cheap, continuous, no judgment), review is not (expensive, episodic, all judgment), and
verification is mechanical again — so the expensive human step is sandwiched between two automated ones.

### Phase 0 — GitHub: detect (continuous, no human)

`strape-security.yml`, daily and on dependency-metadata changes. It watches the **current pin** and answers
"has the world changed underneath our reviewed state?": new advisories (`npm audit`, `osv-scanner`), signature
or provenance changes, dependency-health regressions (deps.dev/Scorecard), new GuardDog threat rules, SBOM
drift, high-scrutiny version drift, Socket behavioural alerts.

Nothing here reviews anything. It produces the *trigger* for Phase 1.

### Phase 1 — Local: scope (human, minutes)

```sh
git fetch upstream --tags
node strape/scripts/sync.mjs --target v0.86.0     # prints exactly what must be reviewed
```

Stage A tells you the source diff in reviewed scope, which hot-path files moved, the lockfile delta, and
whether upstream touched a hunk-bearing file. If nothing in the hot-path table changed and the drift checks
pass, Phase 2 is a short delta review rather than a full one.

### Phase 2 — Local: review, fix, sign off (human + LLM, 30-60 min per release)

This is the only phase that cannot be automated, and the only one that needs credentials.

```sh
# review the diff (LLM, diff mode)
#   .claude/skills/source-audit   — capability drift + threat review of changed hot paths
#   .claude/skills/dep-review     — new/changed packages only, at their exact shrinkwrap paths

node strape/scripts/sync.mjs --target v0.86.0 --merge    # vendor ff + merge to main
node strape/scripts/sync.mjs --verify                     # local dry run of the CI gates
# apply any fixes; re-run the affected review agents (the tree changed — see the freeze rule)

# regenerate the baselines that legitimately moved, reviewing each diff:
node strape/scripts/capability-sweep.mjs --json strape/audit/capability-sweep-v0.86.0.json
node strape/scripts/sbom.mjs
node strape/scripts/dep-health.mjs   --json strape/audit/dep-health-v0.86.0.json
node strape/scripts/provenance.mjs   --json strape/audit/provenance-v0.86.0.json
node strape/scripts/guarddog-scan.mjs --json strape/audit/guarddog-v0.86.0.json
node strape/scripts/test-expectations.mjs --log /tmp/suite.log --record

# ONLY if the catalog was re-hydrated this sync. Read the model delta first — `--check` prints it, and
# `baseUrl` changes are flagged. Re-hydration pulls models.dev as of TODAY, not as of v0.86.0, so this is
# the step where third-party data enters a commit named after an upstream tag. See HUNKS.md hunk 6.
node strape/scripts/model-catalog.mjs --check strape/audit/model-catalog-v0.84.1.json   # read the delta
node strape/scripts/model-catalog.mjs --record                                          # then freeze it

node strape/scripts/sync.mjs --adopt v0.86.0              # write the new UPSTREAM_PIN
# write strape/audit/review-v0.86.0.md, fill reviewedBy/reviewedAt in reviewed-deps.json

node strape/scripts/review-attest.mjs --record --by "Your Name" --date 2026-09-01
```

The attestation refuses to record while any dependency verdict is not `allow`, while any allowed dependency
has no `reviewedBy`, or while the review record for the pin is missing. You cannot accidentally sign off on an
unfinished review.

Then open a PR from the sync branch.

### Phase 3 — GitHub: verify (CI, no human)

`strape-build.yml` on the PR. Cheapest checks first so a reverted hunk fails in seconds:

1. `verify-overlay` — all hunks intact
2. **`review-attest --verify`** — a sign-off exists, covers this pin, and the reviewed content is byte-identical
3. `lockfile-audit`, upstream's own pinned-deps/shrinkwrap checks
4. drift gates: capability sweep, SBOM
5. `reviewed-deps` — every shipped package has an `allow` verdict + matching integrity
6. `build:offline`, rebrand smoke tests, provider catalog offline, module guard
7. `compat-test` (CLAUDE.md + `.claude/skills`), `trust-regression-test`, `agent-dir-perms-test`
8. `test-expectations` — the failure set is exactly the reviewed one

A green PR means: reviewed by a named human, unchanged since, and mechanically sound. Merge.

### Phase 4 — GitHub: release (CI, on tag)

`strape-release.yml` on `strape-v*`. Re-runs the full verification on the tagged commit, builds offline, packs
a distributable artifact with a sha256, and attaches it to a GitHub release. Because it re-verifies rather than
trusting the PR run, a tag can never ship an artifact from an unreviewed tree.

## Versioning: keep upstream's, add our own alongside

**We do not set a strape version in `package.json`.** That is the whole policy, and it is enforced by a
`verify-overlay` invariant.

The reason is concrete rather than aesthetic. 17 tracked `package.json` files carry a version, upstream bumps
them all in lockstep (`npm version --workspaces` + `scripts/sync-versions.js`), and the internal packages depend
on each other through `^0.84.0` ranges. Setting a strape version there would cost:

- a merge conflict in ~17 files on **every** upstream release, forever, for no functional gain;
- broken internal ranges — `0.84.0-strape.1` is a *pre-release* and does **not** satisfy `^0.84.0`; the only
  semver-safe alternative is `+build` metadata, which most tooling then ignores anyway.

So `strape --version` keeps reporting the upstream base (`0.84.0`), which is the single most useful number for
correlating behaviour with upstream code, and strape's identity lives in three files we own:

| Where | What it answers |
|---|---|
| `strape/VERSION` | what changed in **our** layer |
| `strape/audit/UPSTREAM_PIN` | which reviewed upstream tag this is based on |
| git tag `strape-v<VERSION>` | the exact released commit |

`strape/VERSION` semantics — note these answer a different question than upstream's numbers:

- **MAJOR** — breaking for strape's users: the binary or config dir renamed, provider scope changed, or a hunk
  that changes observable behaviour. **We start at `0.1.0` and stay pre-1.0** until the review is signed off and
  the Part 2 backlog is worked down; `1.0.0` should mean "we stand behind this for daily use", not "the first
  build happened".
- **MINOR** — **a new upstream pin was adopted and reviewed.** This is the common case, and making it a MINOR
  bump is the point: "we moved to a new upstream" is exactly the change a user cares about.
- **PATCH** — strape-only: gates, scripts, docs, regenerated baselines. No upstream movement.

**Pre-1.0 exception.** While the version is `0.x`, a MAJOR-class change bumps **MINOR** instead. That is the
standard semver convention for 0.x, and it is the only reading that does not force `1.0.0` before we mean it —
the paragraph above reserves `1.0.0` for "we stand behind this for daily use", and a behaviour-changing hunk
landing during the pre-1.0 phase must not spend that number. So pre-1.0 MINOR carries two meanings, "new
upstream pin" and "behaviour changed"; that is not ambiguous in practice, because `strape/audit/UPSTREAM_PIN`
answers which of the two it was. PATCH keeps its meaning exactly: strape-only, no observable behaviour change.

Worked example: hunk 10 made `strape update` refuse to self-update — observable behaviour, no new pin — so
`0.1.0` → `0.2.0`, not `1.0.0`.

What you actually see:

```console
$ strape --version
strape 0.2.0 (upstream pi pin v0.84.0)
0.84.0

$ node strape/scripts/version.mjs
strape 0.2.0 (upstream pi 0.84.0 @ v0.84.0, 77c8e39924f3)
```

The first line comes from the launcher — a file we own, so surfacing it costs no upstream divergence. Without
it, two strape builds with different hunks would both report `0.84.0` and be indistinguishable in a bug report.
Release artifacts are named `strape-<tag>-upstream-<pin>`, carrying both halves.

`node strape/scripts/version.mjs --check` runs in the release workflow and fails if the git tag disagrees with
`strape/VERSION`, if `UPSTREAM_PIN` disagrees with the pin the review attestation covers, or if a baseline for
the current pin is missing. That last one is what stops a release built on an upstream tag nobody reviewed.

**Bumping, in practice**, from today's `0.4.1`:

| Change | `UPSTREAM_PIN` | `strape/VERSION` | Tag |
|---|---|---|---|
| Adopt upstream v0.86.0 | `v0.86.0` | `0.4.1` → `0.5.0` | `strape-v0.5.0` |
| A hunk that changes what a user sees | unchanged | `0.4.1` → `0.5.0` (pre-1.0 exception) | `strape-v0.5.0` |
| Fix a gate script, doc, or baseline | unchanged | `0.4.1` → `0.4.2` | `strape-v0.4.2` |

Worked examples so far: `0.2.0` → `0.3.0` was hunks 13-15 (observable behaviour, no new pin); `0.3.0` →
`0.4.0` was adopting v0.84.1 (new pin); `0.4.0` → `0.4.1` was the model-catalog freeze plus the
expected-failure reclassification — new gate, new baseline, new script, **zero `packages/**` diff**, which is
the textbook PATCH.

## The split, explicitly

### CI — deterministic, no credentials beyond `SOCKET_API_KEY`

| Script | Why CI is right |
|---|---|
| `verify-overlay` | pure file assertions |
| `review-attest --verify` | recompute a digest; **must** run here, it is the enforcement point |
| `lockfile-audit`, `sbom --check`, `capability-sweep --check` | deterministic, offline |
| `reviewed-deps`, `high-scrutiny-check`, `test-expectations` | deterministic, offline |
| `compat-test`, `trust-regression-test`, `agent-dir-perms-test` | need a build, no network, no keys |
| `dep-health`, `provenance` | network, **no auth** — deps.dev and the npm registry are public |
| `guarddog-scan`, `sbom-crosscheck`, `osv-scanner` | network to fetch the tool; analysis is local to the runner |
| `socket-scan` | needs `SOCKET_API_KEY`; a scoped read-only token is appropriate for CI |

### Local — judgment, credentials, or per-machine state

| Task | Why not CI |
|---|---|
| `.claude/skills/source-audit`, `.claude/skills/dep-review` | need an LLM and provider credentials, and the adoption decision is ours to make deliberately |
| `review-attest --record` | it *is* the human sign-off. CI writing it would defeat the entire mechanism |
| Filling `reviewedBy`/`reviewedAt` | same |
| `sync.mjs --target / --merge / --adopt` | git history decisions and conflict resolution |
| `provision-tools --record` | recording a binary hash requires a human checking provenance on a trusted machine |
| `claude-compat` | configures a developer's own machine |
| `./test.sh` **first** run | fine in CI, but locally it needs the Volta workaround (see INSTALL.md) |

### Deliberately in both

`sync.mjs --verify` runs the CI gate set locally so you find failures before opening a PR. Same scripts, same
results; CI is the authority, local is the fast feedback loop.

## Why not the alternatives

- **Everything in CI, with provider keys as secrets.** The adoption decision moves back into the pipeline, and
  every CI run becomes a credential-exfiltration target. The `.npmrc`-steering and env-passthrough findings in
  `review-v0.84.0.md` are exactly this shape.
- **Everything local.** Works until someone is in a hurry. No enforcement, no daily detection, and the
  question "was this build reviewed?" has no answer you can check.
- **Self-hosted runner with credentials, doing the LLM review in CI.** Defensible at larger scale, and the
  attestation model still applies. Not worth the runner maintenance for a monthly review on a 50-package
  closure — revisit if the review cadence ever becomes weekly.

## One rule that is easy to get wrong

**Do not fix code while a review pass is running.** Two verifiers once "refuted" a real finding because they
read post-fix code and concluded the vulnerability never existed. Batch fixes, then re-run verification for
whatever you touched — and use the `FIXED_IN_STRAPE` verdict rather than `REFUTED`, so the record keeps the
reason each hunk exists. Full story in `strape/research/08-security-review-findings.md` §5.
