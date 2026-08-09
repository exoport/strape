#!/usr/bin/env node
/**
 * Dependency health signals from deps.dev (Google) — free, no account, no API key.
 *
 * WHY THIS EXISTS
 * `high-scrutiny.json` started as hand-picked judgment: "this package feels thinly trusted". That does not
 * scale and cannot be re-run. deps.dev serves, per package, the data those judgments were guessing at — and
 * it already surfaces each project's **OpenSSF Scorecard** score, so we get Scorecard without running the
 * scanner or holding a GitHub token.
 *
 * What this closes (from strape/research/09-dependency-security-tooling.md):
 *   gap 2 — maintainer/repo health, reproducibly, instead of a hand-maintained list
 *   partial gap 6 — deprecation, advisory keys and publish age are cheap typosquat/abandonment signals
 * What it does NOT close: behavioural diffing of a new version (that is Socket.dev's job) and anything about
 * the tarball contents (that is GuardDog + the tarball review).
 *
 * Usage:
 *   node strape/scripts/dep-health.mjs                       # report to stdout
 *   node strape/scripts/dep-health.mjs --json <out>           # write the baseline
 *   node strape/scripts/dep-health.mjs --check <baseline>     # fail on material regressions
 *   node strape/scripts/dep-health.mjs --suggest              # who belongs in high-scrutiny.json
 *
 * Offline by default in spirit: this is the ONE strape script that needs network. It is a review-time and
 * CI-time tool, never invoked by a build or by the harness at runtime.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
const API = "https://api.deps.dev/v3alpha";

const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const suggest = args.includes("--suggest");
const jsonOut = flag("--json");
const checkPath = flag("--check");

/**
 * Thresholds. Deliberately conservative: this tool produces review triggers, never verdicts. A low score is
 * not a vulnerability — chalk scores 4.6 and is fine — so these are tuned to "a human should look", and the
 * --check gate only fires on a *regression* against the reviewed baseline, not on an absolute value.
 */
const SCORECARD_FLOOR = 3.0;
const YOUNG_DAYS = 30;
/**
 * Only checks where a zero means something for a *build dependency* we ship.
 * Deliberately NOT included, after seeing the real distribution over this closure:
 *   Maintained=0  — normal for finished micro-packages (ms, isexe, path-key are done, not abandoned)
 *   Code-Review=0 — normal for solo maintainers, which is most of npm
 * Including them flagged 42 of 50 packages, which is the same as flagging nothing.
 */
const CRITICAL_CHECKS = ["Dangerous-Workflow", "Binary-Artifacts"];
/** Reported for context but never a flag on their own. */
const CONTEXT_CHECKS = ["Maintained", "Code-Review", "Pinned-Dependencies", "Token-Permissions"];

const sw = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const pkgs = [];
for (const [path, meta] of Object.entries(sw.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith("@earendil-works/pi-")) continue;
	pkgs.push({ name, version: meta.version });
}
pkgs.sort((a, b) => a.name.localeCompare(b.name));

const get = async (url) => {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(url, { headers: { "User-Agent": "strape-dep-health" } });
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} catch (e) {
			if (attempt === 2) return { __error: String(e.message ?? e) };
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
		}
	}
	return null;
};

const enc = encodeURIComponent;
const results = [];

for (const p of pkgs) {
	const v = await get(`${API}/systems/npm/packages/${enc(p.name)}/versions/${enc(p.version)}`);
	const row = {
		name: p.name,
		version: p.version,
		licenses: v?.licenses ?? [],
		deprecated: v?.isDeprecated ?? null,
		deprecatedReason: v?.deprecatedReason || "",
		publishedAt: v?.publishedAt ?? null,
		advisories: (v?.advisoryKeys ?? []).map((a) => a.id ?? a),
		attestations: (v?.attestations ?? []).length,
		slsa: (v?.slsaProvenances ?? []).length,
		projectId: null,
		scorecard: null,
		scorecardChecks: {},
		stars: null,
		error: v?.__error ?? null,
	};

	// Prefer the SOURCE_REPO relation; that is the repo whose health actually matters.
	const rel = v?.relatedProjects ?? [];
	const src = rel.find((r) => r.relationType === "SOURCE_REPO") ?? rel[0];
	if (src?.projectKey?.id) {
		row.projectId = src.projectKey.id;
		const proj = await get(`${API}/projects/${enc(src.projectKey.id)}`);
		if (proj && !proj.__error) {
			row.scorecard = proj.scorecard?.overallScore ?? null;
			row.stars = proj.starsCount ?? null;
			for (const c of proj.scorecard?.checks ?? []) row.scorecardChecks[c.name] = c.score;
		}
	}

	const ageDays = row.publishedAt ? Math.floor((Date.now() - Date.parse(row.publishedAt)) / 86400000) : null;
	row.ageDays = ageDays;
	row.flags = [];
	row.context = [];
	if (row.deprecated) row.flags.push("deprecated");
	if (row.advisories.length) row.flags.push(`advisories:${row.advisories.length}`);
	if (!row.licenses.length) row.flags.push("no-license-metadata");
	if (ageDays !== null && ageDays < YOUNG_DAYS) row.flags.push(`young:${ageDays}d`);
	if (row.scorecard !== null && row.scorecard < SCORECARD_FLOOR) row.flags.push(`scorecard:${row.scorecard}`);
	for (const c of CRITICAL_CHECKS) {
		if (row.scorecardChecks[c] === 0) row.flags.push(`${c}=0`);
	}
	// Context, not flags: useful when a human is already looking, noise if it gates.
	if (row.scorecard === null) row.context.push("no-scorecard");
	else if (row.scorecard < 5) row.context.push(`scorecard:${row.scorecard}`);
	for (const c of CONTEXT_CHECKS) {
		if (row.scorecardChecks[c] === 0) row.context.push(`${c}=0`);
	}
	results.push(row);
}

const withFlags = results.filter((r) => r.flags.length);

if (jsonOut) {
	writeFileSync(jsonOut, `${JSON.stringify({ source: "deps.dev v3alpha", packages: results }, null, "\t")}\n`);
	console.log(`Wrote ${jsonOut} (${results.length} packages)`);
}

if (checkPath) {
	if (!existsSync(checkPath)) {
		console.error(`Missing baseline ${checkPath}. Create it with --json.`);
		process.exit(1);
	}
	const base = JSON.parse(readFileSync(checkPath, "utf-8"));
	const bm = new Map((base.packages ?? []).map((r) => [`${r.name}@${r.version}`, r]));
	const regressions = [];
	for (const r of results) {
		const b = bm.get(`${r.name}@${r.version}`);
		if (!b) {
			regressions.push(`${r.name}@${r.version}: not in baseline (new or version changed) — review it`);
			continue;
		}
		// Only *material* movement fails: new advisory, new deprecation, or a real Scorecard drop.
		const newAdv = r.advisories.filter((a) => !(b.advisories ?? []).includes(a));
		if (newAdv.length) regressions.push(`${r.name}@${r.version}: NEW advisory ${newAdv.join(", ")}`);
		if (r.deprecated && !b.deprecated) regressions.push(`${r.name}@${r.version}: newly deprecated — ${r.deprecatedReason}`);
		if (r.scorecard !== null && b.scorecard !== null && r.scorecard <= b.scorecard - 1.0) {
			regressions.push(`${r.name}@${r.version}: Scorecard ${b.scorecard} -> ${r.scorecard}`);
		}
		for (const c of CRITICAL_CHECKS) {
			if (r.scorecardChecks[c] === 0 && b.scorecardChecks?.[c] > 0) {
				regressions.push(`${r.name}@${r.version}: ${c} regressed to 0`);
			}
		}
	}
	console.log(`dep-health check: ${results.length} packages against ${checkPath}`);
	if (regressions.length) {
		console.error(`\n${regressions.length} material regression(s):`);
		for (const r of regressions) console.error(`  ${r}`);
		console.error("\nEach is a review trigger. Re-baseline only after understanding it.");
		process.exit(1);
	}
	console.log("No material health regressions.");
	process.exit(0);
}

if (suggest) {
	const reg = JSON.parse(readFileSync(join(repoRoot, "strape/audit/high-scrutiny.json"), "utf-8"));
	const registered = new Set(Object.keys(reg.packages ?? {}));
	console.log("high-scrutiny.json cross-check\n");
	const shouldAdd = withFlags.filter((r) => !registered.has(r.name));
	const noSignal = [...registered].filter((n) => {
		const r = results.find((x) => x.name === n);
		return r && !r.flags.length;
	});
	if (shouldAdd.length) {
		console.log("Candidates NOT currently registered (deps.dev flagged them):");
		for (const r of shouldAdd) console.log(`  ${r.name}@${r.version}  ${r.flags.join(" ")}`);
	} else console.log("No unregistered package carries a deps.dev flag.");
	if (noSignal.length) {
		console.log("\nRegistered but deps.dev shows no signal (keep them — the reason is human judgment");
		console.log("deps.dev cannot see, e.g. unreadable WASM/native artifacts or a single maintainer):");
		for (const n of noSignal) console.log(`  ${n}`);
	}
	process.exit(0);
}

if (!jsonOut) {
	console.log(`deps.dev health for ${results.length} shipped packages\n`);
	const scored = results.filter((r) => r.scorecard !== null).map((r) => r.scorecard);
	if (scored.length) {
		const avg = (scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(2);
		console.log(`Scorecard: ${scored.length}/${results.length} packages have one, mean ${avg}`);
	}
	console.log(`Review triggers: ${withFlags.length} of ${results.length}\n`);
	for (const r of withFlags.sort((a, b) => (a.ageDays ?? 9e9) - (b.ageDays ?? 9e9))) {
		const ctx = r.context.length ? `   [${r.context.join(" ")}]` : "";
		console.log(`  ${`${r.name}@${r.version}`.padEnd(44)} ${r.flags.join(" ")}${ctx}`);
	}
	if (!withFlags.length) console.log("  (none)");
	const errs = results.filter((r) => r.error);
	if (errs.length) console.log(`\n${errs.length} lookup error(s) — network or API issue, not a finding.`);
}
