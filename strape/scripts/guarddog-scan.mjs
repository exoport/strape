#!/usr/bin/env node
/**
 * GuardDog (Datadog) sweep over the shipped dependency closure.
 *
 * WHY THIS EXISTS
 * `npm audit` and `osv-scanner` answer "does this version have a published advisory?". GuardDog answers a
 * different and, for this project, more useful question: "does this tarball *behave* like malware?" — install
 * scripts that touch the network, obfuscated or dynamically-evaluated code, exfiltration shapes, typosquat
 * heuristics. That is the category with no CVE yet, which is where npm attacks actually live.
 *
 * It is the third-party analogue of strape's own first-party capability sweep, so the two are deliberately
 * kept side by side: `capability-sweep.mjs` for our source, this for their tarballs.
 *
 * Scans each package at its EXACT shrinkwrap nesting path, not `node_modules/<name>` — see
 * hand-verified-findings.md HV-7, where reviewing a hoisted dev-tree copy instead of the shipped nested one
 * meant the shipped artifact was never looked at.
 *
 * Setup (once):
 *   uv venv --python 3.12 strape/tools/guarddog-venv
 *   uv pip install --python strape/tools/guarddog-venv/bin/python guarddog
 * (plain `python3 -m venv` + pip works too, but GuardDog's pygit2 dependency has no wheel for Python 3.14,
 *  so pin an older interpreter.)
 *
 * Usage:
 *   node strape/scripts/guarddog-scan.mjs                      # scan + report
 *   node strape/scripts/guarddog-scan.mjs --json <out>          # write findings baseline
 *   node strape/scripts/guarddog-scan.mjs --check <baseline>    # fail on NEW findings
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
// Overridable so guarddog-gate-test.mjs can drive the tool-failure paths with a stub. Nothing else sets it.
const guarddog = process.env.STRAPE_GUARDDOG_BIN || join(repoRoot, "strape/tools/guarddog-venv/bin/guarddog");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");

const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const jsonOut = flag("--json");
const checkPath = flag("--check");

if (!existsSync(guarddog)) {
	console.error(`GuardDog not installed at ${guarddog}`);
	console.error("Install: uv venv --python 3.12 strape/tools/guarddog-venv && \\");
	console.error("         uv pip install --python strape/tools/guarddog-venv/bin/python guarddog");
	process.exit(1);
}

const sw = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const targets = [];
for (const [path, meta] of Object.entries(sw.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith("@earendil-works/pi-")) continue;
	targets.push({ name, version: meta.version, path });
}
targets.sort((a, b) => a.path.localeCompare(b.path));

/**
 * GuardDog reports `capability-*` rules (this code CAN do X) separately from `threat-*` rules (this looks
 * like an attack). Capabilities are expected in real packages — undici does network by definition — so the
 * signal is threat rules plus GuardDog's own risk score. Capabilities are recorded, never gated on.
 */
const rows = [];
let scanned = 0;
let unavailable = 0;

for (const t of targets) {
	const abs = join(repoRoot, t.path);
	if (!existsSync(abs)) {
		rows.push({ ...t, status: "not-installed", threats: [], capabilities: [], riskScore: null });
		unavailable++;
		continue;
	}
	let out;
	try {
		out = execFileSync(guarddog, ["npm", "scan", abs, "--no-sandbox", "--output-format", "json"], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (e) {
		// GuardDog exits non-zero only with --exit-non-zero-on-finding, which we do not pass; a throw here
		// is a real tool error, and swallowing it would fake a clean scan.
		rows.push({ ...t, status: `scan-error: ${String(e.message ?? e).slice(0, 120)}`, threats: [], capabilities: [], riskScore: null });
		continue;
	}
	let parsed;
	try {
		parsed = JSON.parse(out.slice(out.indexOf("{")));
	} catch {
		rows.push({ ...t, status: "unparseable-output", threats: [], capabilities: [], riskScore: null });
		continue;
	}
	const results = parsed.results ?? {};
	const hit = (k) => Array.isArray(results[k]) && results[k].length > 0;
	const threats = Object.keys(results).filter((k) => k.startsWith("threat-") && hit(k));
	const capabilities = Object.keys(results).filter((k) => k.startsWith("capability-") && hit(k));
	rows.push({
		...t,
		status: "scanned",
		threats,
		capabilities,
		riskScore: parsed.risk_score?.score ?? null,
		riskLabel: parsed.risk_score?.label ?? null,
		threatDetail: threats.map((k) => ({
			rule: k,
			sites: (results[k] ?? []).slice(0, 4).map((f) => `${f.location ?? "?"}: ${String(f.match ?? "").slice(0, 60)}`),
		})),
	});
	scanned++;
}

const withThreats = rows.filter((r) => r.threats.length);
const risky = rows.filter((r) => (r.riskScore ?? 0) > 0);

if (jsonOut) {
	writeFileSync(jsonOut, `${JSON.stringify({ tool: "guarddog", packages: rows }, null, "\t")}\n`);
	console.log(`Wrote ${jsonOut}`);
}

if (checkPath) {
	if (!existsSync(checkPath)) {
		console.error(`Missing baseline ${checkPath}. Create it with --json.`);
		process.exit(1);
	}
	const base = JSON.parse(readFileSync(checkPath, "utf-8"));
	const bm = new Map((base.packages ?? []).map((r) => [`${r.name}@${r.version}`, r]));
	const problems = [];
	for (const r of rows) {
		const b = bm.get(`${r.name}@${r.version}`);
		if (!b) {
			problems.push(`${r.name}@${r.version}: not in baseline (new or bumped) — scan and review before allowing`);
			continue;
		}
		// A tool failure is not a clean result. Without this, a broken GuardDog passes the gate: scan-error rows
		// carry no threats and a null risk score, so both comparisons below succeed vacuously. Compared against
		// the baseline's own status so platform-pruned sidecars (not-installed in both) stay quiet.
		if (r.status !== "scanned" && b.status === "scanned") {
			problems.push(`${r.name}@${r.version}: ${r.status} — scanned cleanly at baseline, so this is a coverage regression, not a clean result`);
			continue;
		}
		const newThreats = r.threats.filter((t) => !(b.threats ?? []).includes(t));
		if (newThreats.length) problems.push(`${r.name}@${r.version}: NEW threat rule(s) ${newThreats.join(", ")}`);
		if ((r.riskScore ?? 0) > (b.riskScore ?? 0)) {
			problems.push(`${r.name}@${r.version}: risk score ${b.riskScore ?? 0} -> ${r.riskScore}`);
		}
	}
	// Backstop the per-package loop cannot provide: nothing scanned at all. GuardDog is the one tool here
	// installed unpinned from PyPI, so a renamed `npm scan` flag in a routine release fails every package at
	// once — and "no new threat rules" over zero coverage reads exactly like a pass.
	const baselineScanned = (base.packages ?? []).filter((r) => r.status === "scanned").length;
	if (scanned === 0 && baselineScanned > 0) {
		problems.push(`0 packages scanned, but the baseline scanned ${baselineScanned} — GuardDog did not run at all; this is a tool failure, not a clean scan`);
	}
	console.log(`guarddog check: ${scanned} scanned against ${checkPath}`);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	console.log("No new threat rules or risk-score increases.");
	process.exit(0);
}

if (!jsonOut) {
	console.log(`GuardDog sweep: ${scanned} scanned, ${unavailable} not installed on this platform\n`);
	console.log(`Packages with threat-rule hits : ${withThreats.length}`);
	console.log(`Packages with risk score > 0   : ${risky.length}\n`);
	for (const r of withThreats.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0))) {
		console.log(`  ${r.name}@${r.version}  risk=${r.riskScore} (${r.riskLabel})`);
		for (const d of r.threatDetail) {
			console.log(`      ${d.rule}`);
			for (const s of d.sites) console.log(`        ${s}`);
		}
	}
	if (!withThreats.length) console.log("  no threat-rule hits");
	const errs = rows.filter((r) => r.status.startsWith("scan-error") || r.status === "unparseable-output");
	if (errs.length) {
		console.log(`\n${errs.length} scan error(s) — these are NOT clean results:`);
		for (const e of errs) console.log(`  ${e.name}@${e.version}: ${e.status}`);
	}
}
