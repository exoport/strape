# strape — credentialed GitHub operations that must not run in CI.
#
# WHY THIS EXISTS
# Dismissing a Dependabot alert is a human judgement, exactly like the review attestation: a pipeline that can
# silence a security signal can silence the one that mattered. So this lives here, driven by a short-lived
# fine-grained token held by a person, and never by `GITHUB_TOKEN` in a workflow.
#
# THE TOKEN NEVER REACHES THE TERMINAL, THE PROCESS TABLE, OR SHELL HISTORY
#   - every recipe line is prefixed `@`, so make does not echo the command
#   - the file is read with SHELL substitution `$$(cat …)` inside the recipe, never make's `$(shell cat …)`:
#     the latter expands at PARSE time, which would put the token into `make -n` output and into make's own
#     error messages. This is the whole reason the file looks like this.
#   - it is passed as an environment variable, so it never appears in argv (`ps` shows nothing)
#   - no target ever cats, echoes or interpolates the value
#
# Run from the repo root:
#   make -f strape/Makefile help
#
# Lives in strape/ rather than at the repo root on purpose: the root is upstream's tree, and a new file there
# is one more thing to reconcile if upstream ever adds its own Makefile. See CLAUDE.md's layout table.

REPO             := exoport/strape
TOKEN_FILE       := hot/strape-dependabot-dismiss.token
EXAMPLES_PREFIX  := packages/coding-agent/examples/
SHIPPED_LOCKFILE := packages/coding-agent/npm-shrinkwrap.json
OSV              := ./strape/tools/osv-scanner

# gh is invoked by explicit FILESYSTEM PATH from strape/tools/, and is deliberately absent from $PATH.
#
# `gh auth login` cannot be turned off — there is no flag, config key or environment variable for it — and it
# persists a broad OAuth token to ~/.config/gh that would then outrank nothing but shadow everything: any gh
# command typed outside this Makefile would use it. The only reliable way not to run a command is for it not
# to be on your PATH. Fetched and sha256-verified by strape/scripts/fetch-tool.mjs, like cosign and syft.
GH               := ./strape/tools/gh

DISMISS_COMMENT := Example extension: hunk 2 removes it from the npm workspaces, so it is never built, \
installed or shipped. The shipped closure ($(SHIPPED_LOCKFILE), 56 packages) scans clean with osv-scanner. \
See strape/docs/SETUP.md section 2.

.DEFAULT_GOAL := help
.PHONY: help preflight scope alerts dismiss-examples verify

help:
	@echo "strape credentialed operations (token: $(TOKEN_FILE))"
	@echo
	@echo "  make -f strape/Makefile preflight         guards: gitignored, untracked, 0600, pinned gh present"
	@echo "  make -f strape/Makefile scope             PROVE the token is narrow (positive + negative)"
	@echo "  make -f strape/Makefile alerts            list open Dependabot alerts + manifest paths"
	@echo "  make -f strape/Makefile dismiss-examples  dry run; add CONFIRM=yes to actually dismiss"
	@echo "  make -f strape/Makefile verify            open-alert count + shipped-closure scan"
	@echo
	@echo "The token is never printed, never in argv, never in shell history."

# ---------------------------------------------------------------------------------------------------
# Guards. These fail CLOSED and run before anything touches the network.
# ---------------------------------------------------------------------------------------------------
preflight:
	@set -eu; \
	test -f "$(TOKEN_FILE)" || { echo "FAIL  missing $(TOKEN_FILE)"; exit 1; }; \
	git check-ignore -q "$(TOKEN_FILE)" || { \
	  echo "FAIL  $(TOKEN_FILE) is NOT gitignored — refusing to run."; \
	  echo "      A token one 'git add -A' away from a public repo is the worst outcome here."; exit 1; }; \
	test -z "$$(git ls-files -- "$(TOKEN_FILE)")" || { \
	  echo "FAIL  $(TOKEN_FILE) is TRACKED by git. Remove it from the index before doing anything else."; exit 1; }; \
	mode=$$(stat -c '%a' "$(TOKEN_FILE)"); \
	case "$$mode" in 600|400) ;; *) \
	  echo "FAIL  $(TOKEN_FILE) is mode $$mode; want 600."; \
	  echo "      It arrived as 0664 once already — group- and world-readable is how a local account reads it."; \
	  echo "      Fix: chmod 600 $(TOKEN_FILE) && chmod 700 $$(dirname $(TOKEN_FILE))"; exit 1;; esac; \
	test -s "$(TOKEN_FILE)" || { echo "FAIL  $(TOKEN_FILE) is empty"; exit 1; }; \
	test -x "$(GH)" || { \
	  echo "FAIL  $(GH) missing. Fetch it pinned and hash-verified:"; \
	  echo "        node strape/scripts/fetch-tool.mjs gh"; \
	  echo "      Deliberately NOT installed system-wide: off PATH, 'gh auth login' cannot be typed."; exit 1; }; \
	echo "ok    $(TOKEN_FILE) is gitignored, untracked, mode $$mode"; \
	echo "ok    $(GH) $$($(GH) --version | head -1 | awk '{print $$3}') (off PATH, pinned)"

# Prove the token can do the one thing and NOT the others. Both negative probes are read-only, so a
# too-broad token is discovered without changing anything.
scope: preflight
	@set -eu; export GH_TOKEN="$$(cat $(TOKEN_FILE))"; \
	printf '%-46s' "granted:  read dependabot alerts"; \
	if $(GH) api "repos/$(REPO)/dependabot/alerts" --jq 'length' >/dev/null 2>&1; \
	  then echo "ok"; else echo "FAIL — token cannot read alerts (pending org approval?)"; exit 1; fi; \
	printf '%-46s' "NOT granted:  read actions secrets"; \
	if $(GH) api "repos/$(REPO)/actions/secrets" >/dev/null 2>&1; \
	  then echo "!! REACHABLE — token is broader than intended; revoke and re-scope"; exit 1; else echo "ok (denied)"; fi; \
	printf '%-46s' "NOT granted:  read webhooks"; \
	if $(GH) api "repos/$(REPO)/hooks" >/dev/null 2>&1; \
	  then echo "!! REACHABLE — token is broader than intended; revoke and re-scope"; exit 1; else echo "ok (denied)"; fi; \
	echo; echo "Token is scoped as intended: Dependabot alerts read/write, nothing else."

# ---------------------------------------------------------------------------------------------------
# Dependabot
# ---------------------------------------------------------------------------------------------------
alerts: preflight
	@set -eu; export GH_TOKEN="$$(cat $(TOKEN_FILE))"; \
	echo "open alerts in $(REPO)  (# / severity / package / manifest):"; echo; \
	$(GH) api "repos/$(REPO)/dependabot/alerts" --paginate \
	  --jq '.[] | select(.state=="open") | "  #\(.number)\t\(.security_advisory.severity)\t\(.dependency.package.name)\t\(.dependency.manifest_path)"' \
	| sort -t'	' -k4,4; \
	echo; \
	echo "Rule: manifest under $(EXAMPLES_PREFIX) -> dismiss. Anything else (e.g. root package-lock.json) -> keep."

# Dry run by default. Dismissal IS reversible (an alert can be reopened), but a security signal is not
# something to silence on a typo, so the write needs CONFIRM=yes stated explicitly.
dismiss-examples: preflight
	@set -eu; export GH_TOKEN="$$(cat $(TOKEN_FILE))"; \
	nums=$$($(GH) api "repos/$(REPO)/dependabot/alerts" --paginate \
	  --jq '.[] | select(.state=="open") | select(.dependency.manifest_path | startswith("$(EXAMPLES_PREFIX)")) | .number'); \
	if [ -z "$$nums" ]; then echo "Nothing to do: no open alerts under $(EXAMPLES_PREFIX)."; exit 0; fi; \
	count=$$(printf '%s\n' "$$nums" | wc -l | tr -d ' '); \
	if [ "$(CONFIRM)" != "yes" ]; then \
	  echo "DRY RUN — would dismiss $$count alert(s) as 'not_used':"; echo; \
	  for n in $$nums; do \
	    $(GH) api "repos/$(REPO)/dependabot/alerts/$$n" \
	      --jq '"  #\(.number)  \(.security_advisory.severity)\t\(.dependency.package.name)\t\(.dependency.manifest_path)"'; \
	  done; \
	  echo; echo "Re-run with: make -f strape/Makefile dismiss-examples CONFIRM=yes"; exit 0; \
	fi; \
	for n in $$nums; do \
	  $(GH) api -X PATCH "repos/$(REPO)/dependabot/alerts/$$n" \
	    -f state=dismissed -f dismissed_reason=not_used \
	    -f dismissed_comment="$(DISMISS_COMMENT)" \
	    --jq '"dismissed #\(.number)  \(.dependency.package.name)  (\(.dependency.manifest_path))"'; \
	done; \
	echo; echo "Done. Now: make -f strape/Makefile verify"

verify: preflight
	@set -eu; export GH_TOKEN="$$(cat $(TOKEN_FILE))"; \
	echo "still open:"; \
	$(GH) api "repos/$(REPO)/dependabot/alerts" --paginate \
	  --jq '.[] | select(.state=="open") | "  #\(.number)  \(.security_advisory.severity)\t\(.dependency.package.name)\t\(.dependency.manifest_path)"' \
	  || true; \
	echo; \
	echo "shipped closure ($(SHIPPED_LOCKFILE)):"; \
	if [ -x "$(OSV)" ]; then $(OSV) scan source --lockfile="$(SHIPPED_LOCKFILE)" 2>/dev/null | tail -3; \
	  else echo "  ($(OSV) not provisioned: node strape/scripts/fetch-osv.mjs)"; fi
