#!/usr/bin/env node
/**
 * Socket.dev scan — the one adopted tool that needs an account.
 *
 * WHY SOCKET AND NOT ANOTHER SCANNER
 * Everything else in strape's stack answers "does this version have a published advisory?" (npm audit,
 * osv-scanner), "is this artifact the one we pinned?" (integrity, provenance.mjs), or "does this tarball look
 * malicious right now?" (guarddog-scan.mjs). None answers the question that actually matters for an
 * already-reviewed closure: **did an approved package's NEW version gain a capability it did not have
 * before?** — a network call, a shell exec, an install script. That version-over-version behavioural diff is
 * Socket's core feature and the shape of the real 2025-2026 npm attacks (chalk/debug maintainer phishing,
 * Shai-Hulud).
 *
 * This script no-ops cleanly when SOCKET_API_KEY is absent, so CI stays green before the account exists and
 * starts enforcing the moment the secret is added. It never fails the build for a *missing* key — silently
 * skipping is honest here, loudly failing would just get the step deleted.
 *
 * Setup (the only paid/account step in the whole stack):
 *   1. Create an org at https://socket.dev (free for public repos; ~$25/dev/mo otherwise)
 *   2. Create an API token, add it as the repo secret SOCKET_API_KEY
 *   3. Optionally install the GitHub App for PR-time comments — complementary, not required by this script
 *
 * HOW IT GATES
 * On DRIFT, like every other tool here — dep-health, provenance, guarddog, capability-sweep and sbom all fail
 * on regression against a reviewed baseline, never on absolute values (SECURITY-TOOLING.md). Socket is the
 * tool whose whole value is the version-over-version diff, so gating it on the mere presence of an alert was
 * both inconsistent and useless: on the real closure it flagged 103 alerts, none of them a finding. A small
 * ALWAYS_BLOCKING set (malware, typosquat, installScripts, …) still fails regardless of baseline, because
 * baselining those would be recording a decision nobody should get to make silently.
 *
 * Usage:
 *   SOCKET_API_KEY=... node strape/scripts/socket-scan.mjs                    # report
 *   SOCKET_API_KEY=... node strape/scripts/socket-scan.mjs --json <out>       # record the baseline
 *   SOCKET_API_KEY=... node strape/scripts/socket-scan.mjs --check <baseline> # the gate
 *   SOCKET_API_KEY=... node strape/scripts/socket-scan.mjs --fail-on-alert    # always-blocking only
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const key = process.env.SOCKET_API_KEY;
const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const failOnAlert = args.includes("--fail-on-alert");
const jsonOut = flag("--json");
const checkPath = flag("--check");
const pinFile = join(repoRoot, "strape/audit/UPSTREAM_PIN");
const pin = existsSync(pinFile) ? readFileSync(pinFile, "utf-8").trim().split(/\s+/)[0] : null;

if (!key) {
	console.log("SOCKET_API_KEY not set — skipping Socket.dev scan.");
	console.log("This is the one adopted tool that needs an account; see strape/docs/SECURITY-TOOLING.md.");
	process.exit(0);
}

const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
if (!existsSync(shrinkwrapPath)) {
	console.error(`Missing ${shrinkwrapPath}. Run: npm run shrinkwrap:coding-agent`);
	process.exit(1);
}

const sw = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const pkgs = [];
for (const [path, meta] of Object.entries(sw.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith("@earendil-works/pi-")) continue;
	pkgs.push({ name, version: meta.version });
}

/**
 * Socket's free "purl" endpoint returns per-package alerts and scores without needing a full project upload,
 * which suits a fixed 50-package closure better than a repo-wide scan.
 */
const endpoint = "https://api.socket.dev/v0/purl?alerts=true";
const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

const body = JSON.stringify({ components: pkgs.map((p) => ({ purl: `pkg:npm/${p.name}@${p.version}` })) });

let res;
try {
	res = await fetch(endpoint, {
		method: "POST",
		headers: { Authorization: auth, "Content-Type": "application/json", "User-Agent": "strape-socket-scan" },
		body,
	});
} catch (e) {
	console.error(`Socket API unreachable: ${String(e.message ?? e)}`);
	process.exit(failOnAlert ? 1 : 0);
}

if (res.status === 401 || res.status === 403) {
	console.error(`Socket API rejected the token (HTTP ${res.status}). Check SOCKET_API_KEY.`);
	process.exit(1);
}
if (!res.ok) {
	console.error(`Socket API returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	process.exit(failOnAlert ? 1 : 0);
}

/** The purl endpoint streams newline-delimited JSON, one object per component. */
const text = await res.text();
const items = text
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

/**
 * Alert types that fail the build no matter what the baseline says. These mean "act now", so baselining one
 * would be recording a decision nobody should get to make silently. Everything else is judged by DRIFT.
 */
const ALWAYS_BLOCKING = new Set([
	"malware",
	"gptMalware",
	"typosquat",
	"didYouMean",
	"installScripts",
	"protestware",
	"obfuscatedRequire",
	"gitDependency",
	"httpDependency",
]);

/**
 * Everything else is judged against a reviewed baseline, not in absolute terms — the same rule the rest of
 * this stack follows (dep-health, provenance, guarddog, capability-sweep, sbom all fail on regression, never
 * on absolute values; see SECURITY-TOOLING.md).
 *
 * Socket's value is the version-over-version diff: "did an approved package gain a capability it did not have
 * before?" Gating on presence cannot express that. Measured on the real 50-package closure on 2026-08-09, the
 * old absolute set produced 103 blocking alerts and not one was a finding — `unmaintained` on four finished
 * micro-packages (proper-lockfile's own verdict already records that it has had no release since 2022),
 * `networkAccess` on undici and openai which ARE the network layer, `shellAccess` on cross-spawn which is a
 * spawn wrapper by definition, and `obfuscatedFile` on highlight.js's Cyrillic language definition, which
 * GuardDog independently flagged and the review already cleared. A gate that is 103-for-103 wrong on first
 * contact does not get read; it gets deleted or ignored.
 *
 * With a baseline, undici doing network today is silent and undici gaining shellAccess tomorrow fails loudly.
 */
const alertTypes = (it) => [...new Set((it.alerts ?? []).map((a) => a.type))].sort();

const current = {};
for (const it of items) {
	const name = it.name ?? it.purl ?? "?";
	current[`${name}@${it.version}`] = alertTypes(it);
}

const report = [];
for (const it of items) {
	const name = it.name ?? it.purl ?? "?";
	const types = alertTypes(it);
	if (!types.length) continue;
	report.push({ id: `${name}@${it.version}`, types, always: types.filter((t) => ALWAYS_BLOCKING.has(t)) });
}

if (jsonOut) {
	writeFileSync(jsonOut, `${JSON.stringify({ tool: "socket.dev", pin, packages: current }, null, "\t")}\n`);
	console.log(`Wrote ${jsonOut} (${Object.keys(current).length} components, ${report.length} with alerts)`);
	process.exit(0);
}

console.log(`Socket.dev scan: ${items.length} components, ${report.length} with alerts\n`);

const problems = [];
if (checkPath) {
	if (!existsSync(checkPath)) {
		console.error(`Missing baseline ${checkPath}. Create it with --json.`);
		process.exit(1);
	}
	const base = JSON.parse(readFileSync(checkPath, "utf-8")).packages ?? {};
	for (const [id, types] of Object.entries(current)) {
		const known = base[id];
		if (!known) {
			// A package or version absent from the baseline was never reviewed against Socket at all.
			if (types.length) problems.push(`${id}: not in baseline (new or bumped) — alerts: ${types.join(", ")}`);
			continue;
		}
		const gained = types.filter((t) => !known.includes(t));
		if (gained.length) problems.push(`${id}: NEW alert type(s) ${gained.join(", ")}`);
	}
	// A tool failure is not a clean result: if the API returned nothing, say so rather than reporting no drift.
	if (!items.length) problems.push("Socket returned 0 components — treat as a tool failure, not a clean scan");
}

for (const r of report) {
	const flag = r.always.length ? `  <-- ${r.always.join(", ")}` : "";
	console.log(`  ${r.id.padEnd(44)} ${r.types.join(", ")}${flag}`);
}
if (!report.length) console.log("  no alerts");

const alwaysHits = report.filter((r) => r.always.length);
for (const r of alwaysHits) problems.push(`${r.id}: ${r.always.join(", ")} — always blocking, never baselined`);

if (checkPath) {
	console.log(`\nsocket check: ${items.length} components against ${checkPath}`);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	console.log("No new alert types, and nothing in the always-blocking set.");
	process.exit(0);
}

if (alwaysHits.length && failOnAlert) {
	console.error(`\n${alwaysHits.length} package(s) hit an always-blocking alert.`);
	process.exit(1);
}
if (alwaysHits.length) console.log(`\n${alwaysHits.length} always-blocking hit(s) — run with --fail-on-alert to enforce.`);
console.log(`\nBaseline mode is the real gate: --json <out> to record, --check <baseline> to enforce drift.`);
