#!/usr/bin/env node
/**
 * strape's version identity — deliberately kept OUT of package.json.
 *
 * WHY WE DO NOT SET OUR OWN package.json VERSION
 * 17 tracked package.json files carry a version, upstream bumps them all in lockstep
 * (`npm version --workspaces` + `scripts/sync-versions.js`), and internal packages depend on each other
 * through `^0.84.0` ranges. Setting a strape version there would mean:
 *   - a merge conflict in ~17 files on every upstream release, forever, for zero functional gain
 *   - breaking the `^` ranges (a `0.84.0-strape.1` pre-release does NOT satisfy `^0.84.0`), or
 *     needing `+build` metadata that most tooling then ignores anyway
 * So `strape --version` continues to report the upstream base version, which is the single most useful
 * number for correlating behaviour with upstream code, and strape's own identity lives here instead.
 *
 * THE IDENTITY HAS THREE PARTS
 *   strape/VERSION            strape's own semver — what changed in OUR layer
 *   strape/audit/UPSTREAM_PIN the reviewed upstream tag this build is based on
 *   git describe              the exact commit, so a build is always traceable
 *
 * Semantics of strape/VERSION (this is the useful bit — it answers a different question than upstream's):
 *   MAJOR  a breaking change for strape's users: the binary/config dir renamed, provider scope changed,
 *          or a hunk that changes observable behaviour
 *   MINOR  a new upstream pin was adopted and reviewed  <- the common case
 *   PATCH  strape-only changes: gates, scripts, docs, baselines; no upstream movement
 * Pre-1.0 exception: while the version is 0.x, a MAJOR-class change bumps MINOR instead, so that 1.0.0 stays
 * reserved for "we stand behind this for daily use". See strape/docs/RELEASE-FLOW.md.
 *
 * Usage:
 *   node strape/scripts/version.mjs            # human-readable identity
 *   node strape/scripts/version.mjs --json
 *   node strape/scripts/version.mjs --check    # CI: tag/VERSION/pin/attestation agree
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const read = (p) => (existsSync(join(repoRoot, p)) ? readFileSync(join(repoRoot, p), "utf-8").trim() : null);

const strapeVersion = read("strape/VERSION");
const pinLine = read("strape/audit/UPSTREAM_PIN");
const [pinTag, pinSha] = (pinLine ?? "").split(/\s+/);

const upstreamVersion = existsSync(join(repoRoot, "packages/coding-agent/package.json"))
	? JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf-8")).version
	: null;

const git = (...args) => {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};

const commit = git("rev-parse", "--short=12", "HEAD");
const dirty = git("status", "--porcelain") ? true : false;
// GITHUB_REF_NAME is set in CI on a tag push; locally fall back to the nearest strape tag.
const tag = process.env.GITHUB_REF_NAME || git("describe", "--tags", "--match", "strape-v*", "--abbrev=0");

const identity = {
	strape: strapeVersion,
	upstreamPin: pinTag ?? null,
	upstreamVersion,
	commit,
	dirty,
	tag: tag && tag.startsWith("strape-v") ? tag : null,
	/** The string to quote in a bug report. */
	display: `strape ${strapeVersion ?? "?"} (upstream pi ${upstreamVersion ?? "?"} @ ${pinTag ?? "unpinned"}, ${commit ?? "no-git"}${dirty ? "-dirty" : ""})`,
};

const args = process.argv.slice(2);

if (args.includes("--json")) {
	console.log(JSON.stringify(identity, null, "\t"));
	process.exit(0);
}

if (args.includes("--check")) {
	const problems = [];

	if (!strapeVersion) problems.push("strape/VERSION missing");
	else if (!/^\d+\.\d+\.\d+$/.test(strapeVersion)) problems.push(`strape/VERSION is not plain semver: "${strapeVersion}"`);
	if (!pinTag) problems.push("strape/audit/UPSTREAM_PIN missing or malformed");
	if (!pinSha) problems.push("UPSTREAM_PIN has no commit sha — record '<tag> <sha>'");

	// On a tag build the tag must match VERSION, or the artifact would be mislabelled.
	if (identity.tag) {
		const tagVersion = identity.tag.replace(/^strape-v/, "");
		if (tagVersion !== strapeVersion) {
			problems.push(`tag ${identity.tag} does not match strape/VERSION (${strapeVersion}) — bump one or the other`);
		}
	}

	// The pin must be the one we cleared. This is what stops a release built on an
	// unreviewed upstream tag: review-attest checks content, this checks the label agrees.
	const attPath = "strape/audit/review-attestation.json";
	if (existsSync(join(repoRoot, attPath))) {
		const att = JSON.parse(readFileSync(join(repoRoot, attPath), "utf-8"));
		if (att.pin && pinTag && att.pin !== pinTag) {
			problems.push(`review attestation covers ${att.pin} but UPSTREAM_PIN says ${pinTag}`);
		}
	} else {
		problems.push(`${attPath} missing — this tree has no recorded review sign-off`);
	}

	// The audit artifacts are named by pin; a mismatch means a baseline was never regenerated for this pin.
	for (const f of [`strape/audit/capability-sweep-${pinTag}.json`, `strape/audit/sbom-${pinTag}.json`]) {
		if (!existsSync(join(repoRoot, f))) problems.push(`${f} missing — regenerate the baseline for this pin`);
	}

	console.log(`strape version check\n\n  ${identity.display}\n`);
	if (problems.length) {
		console.error(`${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	console.log("  version, upstream pin, tag and review attestation all agree.");
	process.exit(0);
}

console.log(identity.display);
console.log();
console.log(`  strape version   ${identity.strape ?? "?"}       (our layer: MAJOR=breaking, MINOR=new upstream pin, PATCH=strape-only)`);
if (strapeVersion?.startsWith("0.")) {
	console.log("                            pre-1.0: a MAJOR-class change bumps MINOR (docs/RELEASE-FLOW.md)");
}
console.log(`  upstream pin     ${identity.upstreamPin ?? "unpinned"}  (reviewed tag this build is based on)`);
console.log(`  upstream version ${identity.upstreamVersion ?? "?"}     (what 'strape --version' reports, unchanged from upstream)`);
console.log(`  commit           ${identity.commit ?? "no-git"}${identity.dirty ? " (working tree dirty)" : ""}`);
console.log(`  release tag      ${identity.tag ?? "(none — tag as strape-v" + (identity.strape ?? "X.Y.Z") + " to release)"}`);
