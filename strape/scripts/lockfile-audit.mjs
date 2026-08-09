#!/usr/bin/env node
/**
 * Deterministic lockfile hygiene checks — the things `npm audit` does not tell you.
 *
 * Fails on:
 *   - any package resolved from a host other than the official registry (registry hijack / typo-mirror)
 *   - any non-https resolved URL
 *   - any package without an integrity hash
 *   - any git/file/http tarball dependency (unauditable, unpinned)
 *   - any lifecycle (install/preinstall/postinstall) script in the shipped closure
 *   - any version range in a direct dependency (upstream pins exactly; a merge could reintroduce ^)
 *
 * Zero dependencies. Offline. Safe to run in CI before anything is installed.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ALLOWED_REGISTRY_HOSTS = new Set(["registry.npmjs.org"]);

const failures = [];
const notes = [];
const internalFromRegistry = [];

const auditLock = (label, path, { requireNoScripts }) => {
	if (!existsSync(path)) {
		notes.push(`${label}: ${path.replace(`${repoRoot}/`, "")} absent — skipped`);
		return;
	}
	const lock = JSON.parse(readFileSync(path, "utf-8"));
	let n = 0;
	for (const [pkgPath, meta] of Object.entries(lock.packages || {})) {
		if (!pkgPath.startsWith("node_modules/")) continue;
		const name = pkgPath.slice(pkgPath.lastIndexOf("node_modules/") + "node_modules/".length);
		if (meta.link) continue; // workspace symlink
		n++;
		const id = `${name}@${meta.version}`;

		// Internal workspace packages are built from source in strape, so they carry no integrity hash.
		// Note (not a failure): upstream's generator still points them at the public registry. Installing
		// straight from this shrinkwrap would therefore fetch them unverified — strape must distribute via
		// scripts/local-release.mjs (file: tarballs) or a built checkout instead. See review-v0.84.0.md.
		if (name.startsWith("@earendil-works/pi-")) {
			internalFromRegistry.push(id);
			continue;
		}
		if (!meta.resolved) {
			failures.push(`${label}: ${id} has no resolved URL`);
			continue;
		}
		let url;
		try {
			url = new URL(meta.resolved);
		} catch {
			failures.push(`${label}: ${id} resolved is not a URL: ${meta.resolved}`);
			continue;
		}
		if (url.protocol !== "https:") failures.push(`${label}: ${id} resolved over ${url.protocol} — ${meta.resolved}`);
		if (!ALLOWED_REGISTRY_HOSTS.has(url.hostname)) {
			failures.push(`${label}: ${id} resolved from unexpected host ${url.hostname}`);
		}
		if (/^git|^file:|\.git#/.test(meta.resolved)) failures.push(`${label}: ${id} is a git/file dependency`);
		if (!meta.integrity) failures.push(`${label}: ${id} has no integrity hash`);
		else if (!/^sha(512|384|256)-/.test(meta.integrity)) {
			failures.push(`${label}: ${id} weak/odd integrity: ${meta.integrity.slice(0, 16)}`);
		}
		if (requireNoScripts && meta.hasInstallScript) {
			failures.push(`${label}: ${id} has a lifecycle script (shipped closure must have none)`);
		}
	}
	notes.push(`${label}: ${n} packages checked`);
};

auditLock("dev-lockfile", join(repoRoot, "package-lock.json"), { requireNoScripts: false });
auditLock("shipped-closure", join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json"), { requireNoScripts: true });

/** Exact-pin check across all workspace manifests (upstream enforces this; assert it survives merges). */
const manifests = ["package.json"];
for (const dir of ["packages", "packages/session-backends"]) {
	const base = join(repoRoot, dir);
	if (!existsSync(base)) continue;
	for (const e of readdirSync(base)) {
		const p = join(base, e, "package.json");
		if (existsSync(p)) manifests.push(p.replace(`${repoRoot}/`, ""));
	}
}
for (const m of manifests) {
	const pkg = JSON.parse(readFileSync(join(repoRoot, m), "utf-8"));
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		for (const [dep, range] of Object.entries(pkg[field] || {})) {
			if (dep.startsWith("@earendil-works/pi-")) continue; // internal, uses ^ by design
			if (typeof range !== "string") continue;
			if (/^[\^~><*]|\s-\s|\|\|/.test(range) || range === "" || range === "latest") {
				failures.push(`${m}: ${field}.${dep} is not exactly pinned: "${range}"`);
			}
			if (/^(git|github:|file:|https?:)/.test(range)) {
				failures.push(`${m}: ${field}.${dep} is a non-registry source: "${range}"`);
			}
		}
	}
}
notes.push(`exact-pin check: ${manifests.length} manifests`);

/** .npmrc posture: these are cheap, high-value supply-chain settings. */
const npmrcPath = join(repoRoot, ".npmrc");
if (existsSync(npmrcPath)) {
	const npmrc = readFileSync(npmrcPath, "utf-8");
	if (!/save-exact\s*=\s*true/.test(npmrc)) failures.push(".npmrc: save-exact=true missing");
	if (!/min-release-age\s*=\s*\d+/.test(npmrc)) {
		failures.push(".npmrc: min-release-age missing (blunts fast-propagating worm releases)");
	}
	if (/registry\s*=\s*(?!https:\/\/registry\.npmjs\.org)/.test(npmrc)) {
		failures.push(".npmrc: registry overridden to a non-official host");
	}
	notes.push(".npmrc: checked");
} else {
	failures.push(".npmrc missing");
}

console.log("strape lockfile audit\n");
for (const n of notes) console.log(`  ok    ${n}`);
if (internalFromRegistry.length) {
	console.log(
		`\n  note  ${internalFromRegistry.length} internal @earendil-works/pi-* entries resolve to the public\n` +
			"        registry with no integrity hash. strape builds these from source — never install\n" +
			"        directly from this shrinkwrap. Distribute via scripts/local-release.mjs.",
	);
}
if (failures.length) {
	console.error("");
	for (const f of failures) console.error(`  FAIL  ${f}`);
	console.error(`\n${failures.length} lockfile hygiene failure(s).`);
	process.exit(1);
}
console.log("\nAll lockfile hygiene checks passed.");
