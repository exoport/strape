#!/usr/bin/env node
/**
 * CycloneDX 1.6 SBOM generator — zero dependencies by design.
 *
 * A supply-chain tool must not enlarge the supply chain it measures, so this deliberately does not use
 * @cyclonedx/cyclonedx-npm (which brings its own dep tree into the trusted build).
 *
 * Source of truth is the shipped closure (packages/coding-agent/npm-shrinkwrap.json), not the dev lockfile:
 * the SBOM should describe what a user actually runs.
 *
 * Usage:
 *   node strape/scripts/sbom.mjs                        # write strape/audit/sbom-<pin>.json
 *   node strape/scripts/sbom.mjs --out FILE
 *   node strape/scripts/sbom.mjs --check FILE           # fail on any component delta vs FILE
 *   node strape/scripts/sbom.mjs --dev                  # describe the dev tree (package-lock.json) instead
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? null : (args[i + 1] ?? true);
};
const dev = args.includes("--dev");

const pin = existsSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"))
	? readFileSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"), "utf-8").trim().split(/\s+/)[0]
	: "unpinned";

const lockPath = dev
	? join(repoRoot, "package-lock.json")
	: join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
const lock = JSON.parse(readFileSync(lockPath, "utf-8"));

const purl = (name, version) => {
	const [scope, bare] = name.startsWith("@") ? name.slice(1).split("/") : [null, name];
	return scope
		? `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(bare)}@${version}`
		: `pkg:npm/${encodeURIComponent(bare)}@${version}`;
};

/** npm integrity is base64 "sha512-…"; CycloneDX wants hex. */
const toHex = (integrity) => {
	if (!integrity) return null;
	const m = /^sha(256|384|512)-(.+)$/.exec(integrity);
	if (!m) return null;
	return { alg: `SHA-${m[1]}`, hex: Buffer.from(m[2], "base64").toString("hex") };
};

const components = [];
const seen = new Set();
for (const [path, meta] of Object.entries(lock.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	const id = `${name}@${meta.version}`;
	if (seen.has(id)) continue;
	seen.add(id);
	const h = toHex(meta.integrity);
	const comp = {
		type: "library",
		"bom-ref": purl(name, meta.version),
		name,
		version: meta.version,
		purl: purl(name, meta.version),
		scope: meta.dev ? "excluded" : "required",
		properties: [
			{ name: "npm:resolved", value: meta.resolved ?? "" },
			{ name: "npm:hasInstallScript", value: String(meta.hasInstallScript === true) },
			...(meta.os ? [{ name: "npm:os", value: [].concat(meta.os).join(",") }] : []),
			...(meta.cpu ? [{ name: "npm:cpu", value: [].concat(meta.cpu).join(",") }] : []),
		],
	};
	if (h) comp.hashes = [{ alg: h.alg, content: h.hex }];
	if (meta.license) comp.licenses = [{ license: { id: meta.license } }];
	components.push(comp);
}
components.sort((a, b) => a.purl.localeCompare(b.purl));

const bom = {
	bomFormat: "CycloneDX",
	specVersion: "1.6",
	version: 1,
	metadata: {
		// No timestamp: a reproducible SBOM must diff cleanly release-over-release.
		component: {
			type: "application",
			name: "strape",
			version: pin,
			description: `strape coding agent — ${dev ? "development" : "shipped"} closure of upstream pi ${pin}`,
		},
		properties: [
			{ name: "strape:source", value: lockPath.replace(`${repoRoot}/`, "") },
			{ name: "strape:upstreamPin", value: pin },
			{ name: "strape:closure", value: dev ? "development" : "shipped" },
		],
	},
	components,
};

const checkFile = flag("--check");
if (typeof checkFile === "string") {
	const baseline = JSON.parse(readFileSync(checkFile, "utf-8"));
	const key = (c) => `${c.purl}|${c.hashes?.[0]?.content ?? "nohash"}`;
	const was = new Map((baseline.components || []).map((c) => [key(c), c]));
	const now = new Map(components.map((c) => [key(c), c]));
	const added = [...now.keys()].filter((k) => !was.has(k));
	const removed = [...was.keys()].filter((k) => !now.has(k));
	if (added.length || removed.length) {
		console.error(`SBOM drift vs ${checkFile}:`);
		for (const a of added) console.error(`  + ${a}`);
		for (const r of removed) console.error(`  - ${r}`);
		console.error("\nEvery addition needs a dependency review before the build is trusted.");
		process.exit(1);
	}
	console.log(`SBOM matches baseline (${components.length} components).`);
	process.exit(0);
}

const out = typeof flag("--out") === "string" ? flag("--out") : join(repoRoot, `strape/audit/sbom-${pin}${dev ? "-dev" : ""}.json`);
writeFileSync(out, `${JSON.stringify(bom, null, "\t")}\n`);
const scripts = components.filter((c) => c.properties.some((p) => p.name === "npm:hasInstallScript" && p.value === "true"));
console.log(`Wrote ${out}`);
console.log(`  ${components.length} components (${dev ? "dev" : "shipped"} closure of ${pin})`);
console.log(`  ${components.filter((c) => c.hashes).length} with integrity hashes`);
console.log(`  ${scripts.length} with install scripts${scripts.length ? `: ${scripts.map((c) => c.name).join(", ")}` : ""}`);
