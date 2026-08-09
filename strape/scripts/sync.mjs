#!/usr/bin/env node
/**
 * Upstream sync driver — the per-release security gate, as a script.
 *
 * Nothing here merges or builds silently. Each stage prints exactly what a reviewer must look at and stops
 * on the first stage that needs a human. Cadence: monthly, or immediately on a GHSA affecting a shipped dep.
 * Never track upstream head (2-5 releases/week is faster than any review can be honest about).
 *
 * Usage:
 *   node strape/scripts/sync.mjs --target v0.86.0            # stage A only: report the diff to review
 *   node strape/scripts/sync.mjs --target v0.86.0 --merge     # stage B: vendor fast-forward + merge to main
 *   node strape/scripts/sync.mjs --verify                     # stage C: invariants + gates + build + smoke
 *   node strape/scripts/sync.mjs --adopt v0.86.0              # stage D: record the new pin (after review)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const PIN_FILE = join(repoRoot, "strape/audit/UPSTREAM_PIN");

const args = process.argv.slice(2);
const val = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : args[i + 1];
};
const target = val("--target") || val("--adopt");
const doMerge = args.includes("--merge");
const doVerify = args.includes("--verify");
const doAdopt = args.includes("--adopt");

const git = (...a) => execFileSync("git", a, { cwd: repoRoot, encoding: "utf-8" }).trim();

/**
 * Run a step, and HALT rather than crash when it fails.
 *
 * execFileSync throws on a non-zero exit, and with no handler Node prints a stack trace ending in
 * `at ChildProcess.spawnSync` — which reads as "the sync tool is broken" when it actually means "a gate
 * stopped you, go look". That misreading is the whole point of this wrapper: in stage C a failing gate is the
 * *expected* outcome after an upstream bump, and the script must say so in the words a reviewer needs.
 *
 * The child has already written its own diagnostics to the inherited stdio, so this adds a frame, not noise,
 * and forwards the child's exit code so callers and CI see the real status.
 */
const run = (cmd, a) => {
	console.log(`\n$ ${cmd} ${a.join(" ")}`);
	try {
		execFileSync(cmd, a, { cwd: repoRoot, encoding: "utf-8", stdio: "inherit" });
	} catch (error) {
		const code = typeof error?.status === "number" ? error.status : 1;
		console.error(`\n${"-".repeat(78)}`);
		console.error(`HALTED: ${cmd} ${a.join(" ")}`);
		console.error(`exited ${code}. Its output is above — read that, not this frame.`);
		if (doVerify) {
			console.error("\nIn stage C this is usually the tooling working, not failing. Drift in");
			console.error("capability-sweep / SBOM / reviewed-deps / model-catalog is EXPECTED after an upstream bump:");
			console.error("it means 'review this change', and the review is the point of the sync.");
			console.error("Re-run stage C once the change is understood and any baseline is deliberately re-recorded.");
		}
		process.exit(code);
	}
};
const pin = existsSync(PIN_FILE) ? readFileSync(PIN_FILE, "utf-8").trim().split(/\s+/)[0] : null;

const section = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

if (!pin) {
	console.error(`No ${PIN_FILE}. Write "<tag> <sha>" into it first.`);
	process.exit(1);
}

/* ------------------------------------------------------------------ stage A */
if (target && !doMerge && !doVerify && !doAdopt) {
	section(`Stage A — scope the review: ${pin} -> ${target}`);
	console.log("Fetching upstream tags…");
	try {
		run("git", ["fetch", "upstream", "--tags"]);
	} catch {
		console.error("git fetch upstream failed (offline?). Fetch manually, then re-run.");
		process.exit(1);
	}
	try {
		git("rev-parse", `${target}^{commit}`);
	} catch {
		console.error(`Tag ${target} not found after fetch. Pick a real release tag (never a branch).`);
		process.exit(1);
	}

	section("A1. Source diff in reviewed scope (read every line of this)");
	console.log(
		git("diff", "--stat", `${pin}..${target}`, "--",
			"packages/coding-agent/src", "packages/ai/src", "packages/agent/src", "packages/tui/src") || "(no changes)",
	);

	section("A2. Files touching security-critical paths");
	const hot = git("diff", "--name-only", `${pin}..${target}`, "--",
		"packages/coding-agent/src/core/tools", "packages/coding-agent/src/core/extensions",
		"packages/coding-agent/src/core/package-manager.ts", "packages/coding-agent/src/core/trust-manager.ts",
		"packages/coding-agent/src/core/settings-manager.ts", "packages/coding-agent/src/core/resource-loader.ts",
		"packages/coding-agent/src/core/skills.ts", "packages/coding-agent/src/core/export-html",
		"packages/ai/src/auth", "packages/ai/src/api");
	console.log(hot || "(none — the review is mostly mechanical this cycle)");
	if (hot) console.log("\n^ Each of these needs the source-audit skill in diff mode, not a skim.");

	section("A3. Dependency changes (the supply-chain review)");
	const lockDiff = git("diff", "--stat", `${pin}..${target}`, "--", "package-lock.json") || "(no lockfile change)";
	console.log(lockDiff);
	const manifests = git("diff", `${pin}..${target}`, "--", "package.json", "packages/*/package.json");
	console.log(manifests || "(no manifest change)");

	section("A4. strape hunk collision forecast");
	const hunkFiles = [
		"packages/coding-agent/package.json",
		"package.json",
		"packages/coding-agent/src/core/system-prompt.ts",
		"packages/ai/package.json",
		"scripts/generate-coding-agent-shrinkwrap.mjs",
		"scripts/generate-coding-agent-install-lock.mjs",
		".gitignore",
	];
	const touched = git("diff", "--name-only", `${pin}..${target}`, "--", ...hunkFiles);
	console.log(touched ? `Upstream touched hunk-bearing files:\n${touched}` : "No hunk-bearing file touched — merge should be clean.");

	section("A5. Upstream changelog + security notes");
	console.log(git("log", "--oneline", `${pin}..${target}`, "--", "packages/coding-agent/CHANGELOG.md") || "(no changelog commits)");
	console.log("\nAlso check: https://github.com/earendil-works/pi/security/advisories");

	section("Next");
	console.log(`Review the above (skills: .claude/skills/source-audit in diff mode, .claude/skills/dep-review
for any new/changed package). Then:
  node strape/scripts/sync.mjs --target ${target} --merge`);
}

/* ------------------------------------------------------------------ stage B */
if (doMerge) {
	if (!target) {
		console.error("--merge requires --target <tag>");
		process.exit(1);
	}
	section(`Stage B — merge ${target}`);
	if (git("status", "--porcelain")) {
		console.error("Working tree is dirty. Commit or stash first.");
		process.exit(1);
	}
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	console.log(`Current branch: ${branch}`);
	run("git", ["checkout", "vendor"]);
	run("git", ["merge", "--ff-only", target]);
	run("git", ["checkout", "main"]);
	console.log("\nMerging vendor into main (merge, never rebase: each conflict is resolved once, in history).");
	try {
		run("git", ["merge", "--no-ff", "vendor", "-m", `strape: merge upstream ${target}`]);
	} catch {
		section("MERGE CONFLICT");
		console.log(git("diff", "--name-only", "--diff-filter=U") || "(see git status)");
		console.log(`
Resolve, keeping strape's side of the 12 hunks (strape/docs/HUNKS.md), then:
  git add -A && git commit
  node strape/scripts/sync.mjs --verify`);
		process.exit(1);
	}
	console.log("\nMerge clean. Next: node strape/scripts/sync.mjs --verify");
}

/* ------------------------------------------------------------------ stage C */
if (doVerify) {
	section("Stage C — verify the merged tree");
	// Order matters: invariants first (cheapest, catches a reverted hunk before a 3-minute build).
	run("node", ["strape/scripts/verify-overlay.mjs"]);
	run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
	run("node", ["strape/scripts/lockfile-audit.mjs"]);
	run("npm", ["run", "shrinkwrap:coding-agent"]);
	run("npm", ["run", "install-lock:coding-agent"]);
	// Baselines are named by the CURRENT pin, not by a literal: this line hardcoded capability-sweep-v0.84.0
	// until 2026-08-11, which meant that after adopting v0.84.1 stage C silently compared every merged tree
	// against the v0.84.0 baseline — noisier, and wrong in the direction that hides real drift behind expected
	// drift. The sbom line beside it was always parameterised, which is what made the mismatch visible.
	run("node", ["strape/scripts/capability-sweep.mjs", "--check", `strape/audit/capability-sweep-${pin}.json`]);
	run("node", ["strape/scripts/sbom.mjs", "--check", `strape/audit/sbom-${pin}.json`]);
	// Offline and cheap. A sync is exactly when the model catalog moves without anyone deciding to move it.
	run("node", ["strape/scripts/model-catalog.mjs", "--check", `strape/audit/model-catalog-${pin}.json`]);
	run("node", ["strape/scripts/reviewed-deps.mjs", "--report"]);
	run("npm", ["run", "build:offline"]);
	run("node", ["packages/coding-agent/dist/cli.js", "--version"]);
	// Runtime assertions, not source ones: upstream can add a new hardcoded name that no invariant knows about.
	run("node", ["strape/scripts/rebrand-test.mjs"]);
	run("node", ["strape/scripts/compat-test.mjs"]);
	run("node", ["strape/scripts/trust-regression-test.mjs"]);
	run("node", ["strape/scripts/agent-dir-perms-test.mjs"]);
	console.log("\nStage C passed. Note: capability-sweep/SBOM/reviewed-deps drift is EXPECTED after an upstream");
	console.log("bump — a failure there means 'review this change', not 'the tooling is broken'.");
	console.log(`Once reviewed: node strape/scripts/sync.mjs --adopt ${target || "<tag>"}`);
}

/* ------------------------------------------------------------------ stage D */
if (doAdopt) {
	section(`Stage D — adopt ${target}`);
	const sha = git("rev-parse", `${target}^{commit}`);
	writeFileSync(PIN_FILE, `${target} ${sha}\n`);
	console.log(`Wrote ${PIN_FILE}: ${target} ${sha}`);
	console.log(`
Remaining human steps (deliberately not automated):
  1. strape/audit/review-${target}.md   — diff-mode review record + sign-off
  2. strape/audit/reviewed-deps.json    — verdicts for new/changed packages (--seed helps)
  3. regenerate baselines that legitimately changed (all six are named by pin; version.mjs --check
     enforces that capability-sweep, sbom and model-catalog exist for the new one):
       node strape/scripts/capability-sweep.mjs --json strape/audit/capability-sweep-${target}.json
       node strape/scripts/sbom.mjs
       node strape/scripts/dep-health.mjs   --json strape/audit/dep-health-${target}.json
       node strape/scripts/provenance.mjs   --json strape/audit/provenance-${target}.json
       node strape/scripts/guarddog-scan.mjs --json strape/audit/guarddog-${target}.json
       node strape/scripts/model-catalog.mjs --check strape/audit/model-catalog-<old pin>.json  # READ the delta
       node strape/scripts/model-catalog.mjs --record                                           # then freeze
  4. repoint strape-build.yml / strape-release.yml at the new baseline filenames
  5. commit, then rebuild/redistribute`);
}

if (!target && !doVerify) {
	console.error("Usage: sync.mjs --target <tag> [--merge] | --verify | --adopt <tag>");
	process.exit(2);
}
