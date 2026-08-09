# Setup: the steps only you can do

Everything else in this repo runs already. These are the items that need a GitHub repository, an account, or a
decision — in the order they must happen, because 1 blocks 2 and 3.

Time: ~30 minutes total, most of it waiting for a CI run.

---

## 0. Prerequisite — push strape to a GitHub repo you own

**Nothing in steps 1-3 is possible before this.** Right now this repo has no remote of its own:

```console
$ git remote -v
local     ../pi                                (fetch/push)
upstream  https://github.com/earendil-works/pi.git
```

`upstream` is pi's repo — you cannot add secrets or enable Dependabot there. You need your own.

**This repo is public**, at `github.com/exoport/strape` — including the security review record. Upstream
classifies this class of issue out of scope, the analysis comes from public source, and the fixes are legible in
the diff regardless; `strape/audit/README.md` states the reasoning. Being public also makes Socket.dev and
Harden-Runner free for this repo, which is a real saving on step 1.

```sh
# 1. Create an EMPTY public repo on GitHub — no README, no .gitignore.
#    github.com/exoport/strape

# 2. Add it and push both branches. Order matters: vendor first, so main's merge base exists.
cd path/to/strape
git remote add origin git@github.com:exoport/strape.git
git push -u origin vendor
git push -u origin main

# 3. Confirm the workflows registered
#    GitHub -> Actions. You should see: strape build gate, strape security scan, strape release.
```

The first `strape build gate` run **will fail**, at two steps, and both failures are correct:

- **Review attestation** — no sign-off is recorded yet (`strape/audit/review-attestation.json` does not exist).
- **Reviewed-dependencies gate** — 26 of 50 dependency verdicts are `escalate`, pending your decisions.

That is the system working. See `strape/docs/RELEASE-FLOW.md` for how to clear them; do not "fix" CI by
weakening either gate.

Also install the GitHub CLI if you want the command-line paths below — otherwise use the web UI:

```sh
sudo apt install gh   # or: brew install gh
gh auth login
```

---

## 1. Socket.dev — the one paid step, and the highest-value one

**Why this one and not another scanner.** Everything else adopted answers "does this version have an
advisory?" or "does this tarball look malicious *right now*?". Socket answers the question a reviewed closure
actually needs: **did an approved package's new version gain a capability it did not have before** — a network
call, a shell exec, an install script. That version-over-version diff is what the 2025 chalk/debug maintainer
phishing and Shai-Hulud attacks looked like from the outside.

### Steps

```
1. Go to https://socket.dev and sign up (GitHub SSO is fine).
2. Create an organisation.
3. Settings -> API Tokens -> New token.
      Scope: read-only is sufficient. This token only needs to look up package reports.
      Name it "strape-ci" so it is obvious what to revoke.
4. Copy the token (it is shown once).
```

Add it as a repository secret:

```sh
gh secret set SOCKET_API_KEY --body "<paste-token>"
# or: GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret
#     Name: SOCKET_API_KEY
```

### Verify it took effect

The step already exists in `strape-security.yml` and currently prints a skip line. After adding the secret:

```sh
gh workflow run "strape security scan"
gh run watch
# In the log, "Socket.dev behavioural diff" should now list components instead of
# "SOCKET_API_KEY not set — skipping".
```

Locally, to see it before touching CI:

```sh
SOCKET_API_KEY=<token> node strape/scripts/socket-scan.mjs
```

### What to expect, and the one judgment call

Socket will report informational alerts that are **true and fine** — `undici` does network access by
definition, `glob` does filesystem access. `strape/scripts/socket-scan.mjs` therefore gates on a specific
list (`malware`, `typosquat`, `installScripts`, `shellAccess`, `obfuscatedFile`, `networkAccess`, …), not on
"any alert".

Run it once with no flags and read what fires against your 50 packages. **Expect almost all of it to be true
and uninteresting** — measured on 2026-08-09 the closure produced 103 alerts of the old blocking types and not
one was a finding: `unmaintained` on four finished micro-packages, `networkAccess` on undici and openai (which
are the network layer), `shellAccess` on cross-spawn (a spawn wrapper by definition) and `obfuscatedFile` on
highlight.js's Cyrillic language definition, already cleared by the review.

That is why the script gates on **drift**, not on presence — the same rule the rest of the stack follows. Two
commands, in this order:

```sh
# 1. record what today's reviewed closure looks like
SOCKET_API_KEY=<token> node strape/scripts/socket-scan.mjs --json strape/audit/socket-<pin>.json

# 2. from then on, this is the gate — fails on a NEW alert type, or any alert on an unbaselined package
SOCKET_API_KEY=<token> node strape/scripts/socket-scan.mjs --check strape/audit/socket-<pin>.json
```

**Commit the baseline before adding the secret.** With a key and no baseline the CI step errors; with neither
it no-ops, which is the state the repo ships in.

A short `ALWAYS_BLOCKING` set (`malware`, `gptMalware`, `typosquat`, `didYouMean`, `installScripts`,
`protestware`, `obfuscatedRequire`, `gitDependency`, `httpDependency`) still fails regardless of the baseline —
baselining those would be recording a decision nobody should get to make silently. If one of those fires on a
package you have reviewed and accepted, record the exception in `reviewed-deps.json` notes. Do not disable the
step, and do not baseline your way past a malware alert.

**Optional:** installing the Socket GitHub App adds PR-time comments. Complementary; the CI step does not need
it.

---

## 2. Dependabot malware alerts — free, one toggle

`.github/dependabot.yml` is already committed. But **malware alerts are a repository setting and cannot be
configured from that file** — this is the step people miss and then assume they are covered.

### Steps

```
GitHub -> your strape repo -> Settings -> Advanced Security
  [x] Dependency graph              (usually already on)
  [x] Dependabot alerts
  [x] Dependabot malware alerts     <- THIS is the one that matters
  [x] Dependabot security updates   (optional; see the note below)
```

With `gh`:

```sh
gh api -X PATCH repos/exoport/strape --field security_and_analysis[dependabot_security_updates][status]=enabled
# Malware alerts have no stable API field at time of writing — use the UI toggle above and confirm visually.
```

### Verify

`Security -> Dependabot alerts` should render (empty is the expected and desired result). The daily
`strape security scan` is unaffected either way — this is an additional, independent signal from GitHub's
advisory database, which now ingests OpenSSF's `malicious-packages` feed.

### Why the config is throttled so hard

`dependabot.yml` sets a 3-PR limit, a 7-day cooldown, and ignores `@earendil-works/*`. That is deliberate:
upstream pi is adopted through the sync playbook against a reviewed tag, never by a bot, and any other bump
must pass the reviewed-deps gate anyway. Dependabot is here for **alerts**, not for churn. If PR noise still
bothers you, set `open-pull-requests-limit: 0` — you keep the alerts and lose the bumps.

---

## 3. Harden-Runner: audit → block

It is already in `strape-security.yml` and `strape-release.yml` with `egress-policy: audit`, which
**observes and reports** but blocks nothing. Switching to `block` is what turns it into a control — and going
straight there without reading the audit output will fail your builds on an endpoint you forgot.

### Steps

```
1. Let the daily "strape security scan" run once with audit mode (or: gh workflow run "strape security scan").
2. Open the run -> the Harden-Runner step -> follow the link to the StepSecurity insights page.
3. Read "Outbound network traffic" — it lists every endpoint the job actually contacted.
4. Add those endpoints to the workflow, then flip the policy.
```

Expected set for this repo, based on what the scripts do — **verify against your own audit output before
trusting this list**:

```yaml
      - name: Harden runner
        uses: step-security/harden-runner@4d991eb9b905ef189e4c376166672c3f2f230481 # v2.11.0
        with:
          egress-policy: block
          allowed-endpoints: >
            api.deps.dev:443
            api.github.com:443
            api.socket.dev:443
            codeload.github.com:443
            github.com:443
            objects.githubusercontent.com:443
            pypi.org:443
            files.pythonhosted.org:443
            registry.npmjs.org:443
```

Where each comes from: `api.deps.dev` (dep-health), `registry.npmjs.org` (npm ci, provenance attestations,
audit signatures), `github.com`/`objects.githubusercontent.com`/`codeload.github.com` (fetching osv-scanner
and Syft, actions checkout), `pypi.org`/`files.pythonhosted.org` (GuardDog's pip install), `api.socket.dev`
(step 1), `api.github.com` (Actions itself).

### Do it one workflow at a time

Flip `strape-security.yml` first — it is the noisiest and runs daily, so it surfaces a missing endpoint
quickly and a failure there does not block a release. Once it has been green for a few days, flip
`strape-release.yml`. Leave `strape-build.yml` without Harden-Runner or add it in audit mode; it runs on every
push and a false block there is maximally annoying.

**If a build fails after flipping:** the Harden-Runner step output names the blocked endpoint. Add it if it is
legitimate — and if it is *not* one you recognise, you have just caught something, which is the entire point.

---

## Order and expected end state

| # | Step | Blocks | Cost | Outcome |
|---|---|---|---|---|
| 0 | Push to a private GitHub repo | everything | free | Workflows run; two gates fail correctly |
| 1 | Socket.dev token | — | free (public) / ~$25/dev/mo | Version-over-version behavioural diffing |
| 2 | Dependabot malware alerts | needs 0 | free | Independent known-malware signal |
| 3 | Harden-Runner → block | needs one audit run | free | CI pipeline itself is constrained |

Afterwards, the two red gates are still red — and should be, until you work through
`strape/docs/RELEASE-FLOW.md` Phase 2: resolve the 26 dependency escalations, fill `reviewedBy`, and record
the review attestation. That is the human review this whole apparatus exists to enforce, and it is deliberately
the one thing no setup step can do for you.
