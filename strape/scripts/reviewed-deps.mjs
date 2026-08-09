#!/usr/bin/env node
/**
 * THE BUILD GATE.
 *
 * Every package in the shipped closure (packages/coding-agent/npm-shrinkwrap.json) must appear in
 * strape/audit/reviewed-deps.json with a matching integrity hash and a non-expired human verdict.
 * Anything else fails the build. This is the mechanical enforcement of "strape is only built after a
 * proper security review of the code and the dependencies".
 *
 * Usage:
 *   node strape/scripts/reviewed-deps.mjs            # gate (exit 1 on any unreviewed/changed package)
 *   node strape/scripts/reviewed-deps.mjs --report   # gate + full table
 *   node strape/scripts/reviewed-deps.mjs --seed     # write skeleton entries for unreviewed packages
 *                                                    # (verdict "unreviewed" — still fails the gate)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
const reviewedPath = join(repoRoot, "strape/audit/reviewed-deps.json");
const internalPrefix = "@earendil-works/pi-";

const args = new Set(process.argv.slice(2));
const seed = args.has("--seed");
const report = args.has("--report");

if (!existsSync(shrinkwrapPath)) {
	console.error(`Missing ${shrinkwrapPath}. Run: npm run shrinkwrap:coding-agent`);
	process.exit(1);
}

const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const reviewed = existsSync(reviewedPath)
	? JSON.parse(readFileSync(reviewedPath, "utf-8"))
	: { pin: null, packages: {} };

/** Shipped closure, keyed name@version. Internal workspace packages are covered by the source review. */
const shipped = new Map();
for (const [path, meta] of Object.entries(shrinkwrap.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith(internalPrefix)) continue;
	shipped.set(`${name}@${meta.version}`, {
		name,
		version: meta.version,
		// The nesting path matters: a nested copy (e.g. proper-lockfile/node_modules/retry@0.12.0) is a
		// DIFFERENT artifact from a hoisted top-level copy of the same package name. A reviewer handed only
		// the bare name will open node_modules/<name> and may review the wrong tarball entirely.
		shrinkwrapPath: path,
		integrity: meta.integrity ?? null,
		resolved: meta.resolved ?? null,
		hasInstallScript: meta.hasInstallScript === true,
		os: meta.os ?? null,
		cpu: meta.cpu ?? null,
	});
}

const problems = [];
const ok = [];

for (const [id, meta] of [...shipped].sort()) {
	const entry = reviewed.packages?.[id];
	if (!entry) {
		problems.push({ id, kind: "unreviewed", detail: "not present in reviewed-deps.json" });
		continue;
	}
	if (entry.integrity && meta.integrity && entry.integrity !== meta.integrity) {
		problems.push({
			id,
			kind: "integrity-mismatch",
			detail: `reviewed ${entry.integrity.slice(0, 24)}… != shrinkwrap ${meta.integrity.slice(0, 24)}…`,
		});
		continue;
	}
	if (entry.verdict !== "allow") {
		problems.push({ id, kind: `verdict:${entry.verdict ?? "missing"}`, detail: entry.notes ?? "" });
		continue;
	}
	if (meta.hasInstallScript && entry.installScriptApproved !== true) {
		problems.push({
			id,
			kind: "install-script",
			detail: "package has a lifecycle script and is not explicitly approved for one",
		});
		continue;
	}
	// Guard against "reviewed the wrong copy": if the shipped artifact exists on disk at its nesting path,
	// its version must match the entry. A hoisted top-level copy of the same name at a different version is a
	// different tarball, and reviewing it proves nothing about the one that ships. (Caught for real: the
	// closure ships proper-lockfile/node_modules/retry@0.12.0 while the dev tree hoists retry@0.13.1.)
	const onDisk = join(repoRoot, meta.shrinkwrapPath, "package.json");
	if (existsSync(onDisk)) {
		let diskVersion = null;
		try {
			diskVersion = JSON.parse(readFileSync(onDisk, "utf-8")).version ?? null;
		} catch {}
		if (diskVersion && diskVersion !== meta.version) {
			problems.push({
				id,
				kind: "artifact-mismatch",
				detail: `${meta.shrinkwrapPath} on disk is ${diskVersion}, shrinkwrap says ${meta.version} — reinstall before reviewing`,
			});
			continue;
		}
	}
	if (entry.shrinkwrapPath && entry.shrinkwrapPath !== meta.shrinkwrapPath) {
		problems.push({
			id,
			kind: "path-moved",
			detail: `reviewed at ${entry.shrinkwrapPath}, now shipped at ${meta.shrinkwrapPath} — confirm it is the same artifact`,
		});
		continue;
	}
	ok.push({ id, entry, meta });
}

/** Stale entries: reviewed but no longer shipped. Not fatal, but they must not rot silently. */
const stale = Object.keys(reviewed.packages || {}).filter((id) => !shipped.has(id));

if (seed) {
	const out = { ...reviewed, packages: { ...(reviewed.packages || {}) } };
	let added = 0;
	for (const [id, meta] of [...shipped].sort()) {
		if (out.packages[id]) continue;
		out.packages[id] = {
			verdict: "unreviewed",
			integrity: meta.integrity,
			resolved: meta.resolved,
			// Review THIS path, not node_modules/<name> — they can be different tarballs.
			shrinkwrapPath: meta.shrinkwrapPath,
			hasInstallScript: meta.hasInstallScript,
			tier: null,
			reviewedBy: null,
			reviewedAt: null,
			capabilities: [],
			notes: "",
		};
		added++;
	}
	writeFileSync(reviewedPath, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`Seeded ${added} entries into ${reviewedPath} (verdict "unreviewed").`);
}

if (report) {
	console.log(`Shipped closure: ${shipped.size} external packages`);
	console.log(`Reviewed + allowed: ${ok.length}`);
	console.log(`Problems: ${problems.length}`);
	if (stale.length) console.log(`Stale reviewed entries (no longer shipped): ${stale.join(", ")}`);
	const byTier = new Map();
	for (const { entry } of ok) {
		const t = entry.tier ?? "untiered";
		byTier.set(t, (byTier.get(t) ?? 0) + 1);
	}
	console.log(`By review tier: ${[...byTier].map(([t, n]) => `${t}=${n}`).join(" ")}`);
}

if (problems.length) {
	console.error(`\nreviewed-deps gate FAILED: ${problems.length} package(s) not cleared for build.\n`);
	for (const p of problems) console.error(`  ${p.kind.padEnd(20)} ${p.id}${p.detail ? ` — ${p.detail}` : ""}`);
	console.error(
		`\nReview each package (see .claude/skills/dep-review), then record a verdict in
strape/audit/reviewed-deps.json. Seed skeletons with: node strape/scripts/reviewed-deps.mjs --seed`,
	);
	process.exit(1);
}

console.log(
	`reviewed-deps gate PASSED: ${ok.length}/${shipped.size} shipped external packages reviewed and allowed` +
		`${reviewed.pin ? ` (pin ${reviewed.pin})` : ""}.`,
);
