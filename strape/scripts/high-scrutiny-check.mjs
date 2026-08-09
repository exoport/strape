#!/usr/bin/env node
/**
 * High-scrutiny register enforcement.
 *
 * Some risk is invisible to every scanner: a package that is young, has one maintainer, or has ~1k
 * downloads/month is not "vulnerable" — it is *thinly trusted*. `npm audit` will never mention it. The only
 * useful control is: read it once, pin it, and fail the build the moment its version moves.
 *
 * Fails if a registered package changed version, disappeared from the closure (stale entry), or is missing
 * a re-review after the configured interval.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const registerPath = join(repoRoot, "strape/audit/high-scrutiny.json");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");

if (!existsSync(registerPath)) {
	console.error(`Missing ${registerPath}.`);
	process.exit(1);
}
if (!existsSync(shrinkwrapPath)) {
	console.error(`Missing ${shrinkwrapPath}. Run: npm run shrinkwrap:coding-agent`);
	process.exit(1);
}

const register = JSON.parse(readFileSync(registerPath, "utf-8"));
const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));

const shipped = new Map();
for (const [path, meta] of Object.entries(shrinkwrap.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	shipped.set(name, meta);
}

const failures = [];
const ok = [];

for (const [name, entry] of Object.entries(register.packages || {})) {
	const meta = shipped.get(name);
	if (!meta) {
		failures.push(
			`${name}: registered as high-scrutiny but no longer in the shipped closure. ` +
				"If it was removed on purpose, delete the register entry in the same commit.",
		);
		continue;
	}
	if (entry.pinnedVersion !== meta.version) {
		failures.push(
			`${name}: version moved ${entry.pinnedVersion} -> ${meta.version}. ` +
				`Re-read the package (reason it is registered: ${entry.reason}), then update pinnedVersion.`,
		);
		continue;
	}
	if (entry.integrity && meta.integrity && entry.integrity !== meta.integrity) {
		failures.push(`${name}@${meta.version}: integrity changed — the same version was republished. Treat as hostile until reviewed.`);
		continue;
	}
	ok.push(`${name}@${meta.version} (${entry.tier ?? "?"}, reviewed ${entry.reviewedAt ?? "never"})`);
}

console.log("strape high-scrutiny register\n");
for (const o of ok) console.log(`  ok    ${o}`);
if (failures.length) {
	console.error("");
	for (const f of failures) console.error(`  FAIL  ${f}`);
	console.error(`\n${failures.length} high-scrutiny failure(s). These are review triggers, not bugs in this script.`);
	process.exit(1);
}
console.log(`\nAll ${ok.length} high-scrutiny packages unchanged since review.`);
