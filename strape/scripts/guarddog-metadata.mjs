#!/usr/bin/env node
/**
 * GuardDog PACKAGE-METADATA sweep — the half of GuardDog that `guarddog-scan.mjs` cannot reach.
 *
 * WHY A SECOND PASS EXISTS
 * `guarddog-scan.mjs` scans each package at its exact shrinkwrap nesting path, deliberately: HV-7 records
 * what happens when you review a hoisted dev-tree copy instead of the artifact that ships. That decision has
 * a cost nobody had measured — scanning a LOCAL PATH runs source-code rules only. Metadata detectors need
 * registry metadata, so all eight of them were silently absent from every scan and from the baseline.
 * Verified 2026-08-11: a local-path scan of undici returns 54 result keys, all `threat-*`/`capability-*`;
 * the same package scanned by NAME returns 62, the extra eight being the metadata rules.
 *
 * WHAT THAT WAS COSTING
 *   potentially_compromised_email_domain  a maintainer's email domain lapsing — the 2025 chalk/debug vector
 *   unclaimed_maintainer_email_domain     the same domain being registrable by an attacker
 *   metadata_mismatch                     registry metadata vs the actual manifest; the openai verdict
 *                                         explicitly records that no tarball-vs-tag diff was ever done
 *   bundled_binary                        binaries inside a package (the clipboard sidecars, photon-node)
 *   deceptive_author                      disposable-email authorship
 *   direct_url_dependency                 a dependency fetched from a URL, i.e. mutable and unpinnable
 *   risky_new_dependency                  a dependency added in this version that is itself risky
 *   typosquatting                         name-confusion against the top packages
 *
 * DIVISION OF LABOUR — deliberate, and neither pass is authoritative for the other's rules:
 *   guarddog-scan.mjs      SHIPPED ARTIFACT, exact nesting path  -> threat-* and capability-* only
 *   this script            REGISTRY name@version                 -> the eight metadata rules only
 * A name-based scan also re-downloads the tarball, so it produces source-code findings too. Those are
 * IGNORED here: the artifact that matters is the one in the shrinkwrap tree, which the other pass reads.
 * Recording both would create two baselines that can disagree about the same rule for the same package.
 *
 * Usage:
 *   node strape/scripts/guarddog-metadata.mjs                      # report
 *   node strape/scripts/guarddog-metadata.mjs --json <out>          # write the baseline
 *   node strape/scripts/guarddog-metadata.mjs --check <baseline>    # fail on NEW metadata findings
 *
 * NETWORK: unlike the local-path pass this one needs the registry, and the two email-domain detectors do
 * DNS/WHOIS lookups. WHOIS is TCP/43, which a Harden-Runner `block` policy allowing only :443 will deny —
 * see the note in strape-security.yml before wiring this into a hardened job.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const guarddog = process.env.STRAPE_GUARDDOG_BIN || join(repoRoot, "strape/tools/guarddog-venv/bin/guarddog");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
const pinFile = join(repoRoot, "strape/audit/UPSTREAM_PIN");

const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const jsonOut = flag("--json");
const checkPath = flag("--check");
const only = flag("--only"); // single package, for debugging
const pin = existsSync(pinFile) ? readFileSync(pinFile, "utf-8").trim().split(/\s+/)[0] : null;

/** The eight package-metadata rules, from `guarddog npm list-rules`. Everything else here is ignored. */
const METADATA_RULES = new Set([
	"potentially_compromised_email_domain",
	"unclaimed_maintainer_email_domain",
	"typosquatting",
	"direct_url_dependency",
	"metadata_mismatch",
	"bundled_binary",
	"deceptive_author",
	"risky_new_dependency",
]);

if (!existsSync(guarddog)) {
	console.error(`GuardDog not installed at ${guarddog}`);
	console.error("Install: uv venv --python 3.12 strape/tools/guarddog-venv && \\");
	console.error("         uv pip install --python strape/tools/guarddog-venv/bin/python guarddog");
	process.exit(1);
}

const sw = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const seen = new Set();
const targets = [];
for (const [path, meta] of Object.entries(sw.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith("@earendil-works/pi-")) continue;
	// Registry identity is name@version: a package nested twice at the same version is one scan, unlike the
	// artifact pass where each nesting path is a distinct thing to read.
	const id = `${name}@${meta.version}`;
	if (seen.has(id)) continue;
	seen.add(id);
	if (only && name !== only) continue;
	targets.push({ name, version: meta.version, id });
}
targets.sort((a, b) => a.id.localeCompare(b.id));

const rows = [];
let scanned = 0;
for (const t of targets) {
	let out;
	try {
		out = execFileSync(guarddog, ["npm", "scan", t.name, "-v", t.version, "--no-sandbox", "--output-format", "json"], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 180_000,
		});
	} catch (e) {
		// Same rule as the artifact pass: a tool failure is not a clean result. Recorded, and fatal in --check.
		rows.push({ ...t, status: `scan-error: ${String(e.message ?? e).slice(0, 120)}`, findings: [] });
		continue;
	}
	let parsed;
	try {
		parsed = JSON.parse(out.slice(out.indexOf("{")));
	} catch {
		rows.push({ ...t, status: "unparseable-output", findings: [] });
		continue;
	}
	const results = parsed.results ?? {};
	const findings = Object.keys(results)
		.filter((k) => METADATA_RULES.has(k))
		.filter((k) => {
			const v = results[k];
			return Array.isArray(v) ? v.length > 0 : Boolean(v);
		})
		.sort();
	// A scan that reported none of the eight rules did not evaluate them — that is not the same as a clean
	// result, and it is what a silent fallback to source-code-only rules would look like.
	const evaluated = Object.keys(results).filter((k) => METADATA_RULES.has(k)).length;
	rows.push({
		...t,
		status: evaluated === METADATA_RULES.size ? "scanned" : `partial: only ${evaluated}/${METADATA_RULES.size} metadata rules evaluated`,
		findings,
		detail: findings.map((k) => ({ rule: k, evidence: String(JSON.stringify(results[k])).slice(0, 300) })),
	});
	if (evaluated === METADATA_RULES.size) scanned++;
}

const withFindings = rows.filter((r) => r.findings.length);
const errors = rows.filter((r) => r.status !== "scanned");

if (jsonOut) {
	writeFileSync(jsonOut, `${JSON.stringify({ tool: "guarddog (package metadata)", pin, packages: rows }, null, "\t")}\n`);
	console.log(`Wrote ${jsonOut} (${scanned} scanned, ${withFindings.length} with findings, ${errors.length} error(s))`);
	process.exit(errors.length ? 1 : 0);
}

console.log(`GuardDog metadata sweep: ${scanned}/${targets.length} scanned\n`);
for (const r of withFindings) console.log(`  ${r.id.padEnd(44)} ${r.findings.join(", ")}`);
if (!withFindings.length) console.log("  no metadata findings");

if (errors.length) {
	console.log(`\n${errors.length} package(s) did not scan cleanly — NOT clean results:`);
	for (const e of errors) console.log(`  ${e.id}: ${e.status}`);
}

if (checkPath) {
	if (!existsSync(checkPath)) {
		console.error(`Missing baseline ${checkPath}. Create it with --json.`);
		process.exit(1);
	}
	const base = JSON.parse(readFileSync(checkPath, "utf-8"));
	const bm = new Map((base.packages ?? []).map((r) => [r.id, r]));
	const problems = [];
	for (const r of rows) {
		const b = bm.get(r.id);
		if (!b) {
			problems.push(`${r.id}: not in baseline (new or bumped) — review before allowing`);
			continue;
		}
		if (r.status !== "scanned" && b.status === "scanned") {
			problems.push(`${r.id}: ${r.status} — scanned cleanly at baseline, so this is lost coverage`);
			continue;
		}
		const gained = r.findings.filter((f) => !(b.findings ?? []).includes(f));
		if (gained.length) problems.push(`${r.id}: NEW metadata finding(s) ${gained.join(", ")}`);
	}
	const baselineScanned = (base.packages ?? []).filter((r) => r.status === "scanned").length;
	if (scanned === 0 && baselineScanned > 0) {
		problems.push(`0 packages scanned but the baseline scanned ${baselineScanned} — tool failure, not a clean sweep`);
	}
	console.log(`\nguarddog metadata check: ${scanned} scanned against ${checkPath}`);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	console.log("No new metadata findings, and no lost coverage.");
	process.exit(0);
}
