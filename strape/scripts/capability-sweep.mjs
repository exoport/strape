#!/usr/bin/env node
/**
 * Mechanical capability inventory over first-party source.
 *
 * Deterministic, zero-dependency, no AI. Produces the authoritative list of
 * every site where the program can execute, write, reach the network, read
 * credentials, or evaluate code. Agent review (see .claude/skills/source-audit)
 * consumes this file; a human signs off on the resulting map.
 *
 * Usage:
 *   node strape/scripts/capability-sweep.mjs                     # human-readable
 *   node strape/scripts/capability-sweep.mjs --json out.json     # machine-readable
 *   node strape/scripts/capability-sweep.mjs --check baseline.json  # CI drift gate
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const SCOPE = [
	"packages/coding-agent/src",
	"packages/ai/src",
	"packages/agent/src",
	"packages/tui/src",
];

const SKIP_DIR = new Set(["node_modules", "dist", ".git", "test", "tests", "__tests__"]);
const SKIP_FILE = /\.(test|spec)\.ts$/;

/**
 * Capability classes. Order matters only for reporting.
 * Each pattern is deliberately broad: false positives are cheap (a reviewer
 * dismisses them), false negatives are not.
 */
const CLASSES = [
	{
		id: "process-exec",
		title: "Process execution",
		why: "Arbitrary command execution — the highest-severity capability in a coding agent.",
		patterns: [
			/\bchild_process\b/,
			/\bspawn(Sync)?\s*\(/,
			/\bexec(Sync|File|FileSync)?\s*\(/,
			/\bfork\s*\(/,
			/node:child_process/,
		],
	},
	{
		id: "dynamic-code",
		title: "Dynamic code evaluation",
		why: "Loading or evaluating code at runtime bypasses static review (extensions, jiti, vm).",
		patterns: [
			/\beval\s*\(/,
			/new\s+Function\s*\(/,
			/\bnode:vm\b/,
			/\bvm\.(runIn|Script|compileFunction)/,
			/\bimport\s*\(/,
			/createRequire\s*\(/,
			/\bjiti\b/,
			/registerHooks\s*\(/,
		],
	},
	{
		id: "network",
		title: "Network egress",
		why: "Any endpoint reached at runtime; must be an LLM provider or an explicitly approved host.",
		patterns: [
			/\bfetch\s*\(/,
			/node:https?\b/,
			/\bhttps?\.request\s*\(/,
			/\bnode:(net|tls|dns)\b/,
			/\bWebSocket\b/,
			/\bundici\b/,
			/https?:\/\/[a-z0-9.-]+/i,
		],
	},
	{
		id: "fs-write",
		title: "Filesystem writes",
		why: "Writes outside the workspace, or to config/credential paths, are a privilege boundary.",
		patterns: [
			/\bwriteFile(Sync)?\s*\(/,
			/\bappendFile(Sync)?\s*\(/,
			/\bmkdir(Sync)?\s*\(/,
			/\brm(Sync|dir|dirSync)?\s*\(/,
			/\bunlink(Sync)?\s*\(/,
			/\brename(Sync)?\s*\(/,
			/\bcreateWriteStream\s*\(/,
			/\bchmod(Sync)?\s*\(/,
			/\bcopyFile(Sync)?\s*\(/,
			/\bsymlink(Sync)?\s*\(/,
		],
	},
	{
		id: "credentials",
		title: "Credential and secret handling",
		why: "API keys, OAuth tokens, auth.json. Leak paths: logs, sessions, telemetry, exports.",
		patterns: [
			/auth\.json/,
			/\bAPI_KEY\b/,
			/apiKey/,
			/\baccessToken\b/,
			/\brefreshToken\b/,
			/\bclient_secret\b/,
			/\bBearer\b/,
			/\bkeytar\b/,
			/credentials/i,
		],
	},
	{
		id: "env",
		title: "Environment access",
		why: "Env-driven behaviour changes; also the main credential source.",
		patterns: [/process\.env\b/],
	},
	{
		id: "temp-paths",
		title: "Temporary paths",
		why: "Predictable temp paths caused CVE-2026-54328 (local privesc) upstream.",
		patterns: [/\btmpdir\s*\(/, /os\.tmpdir/, /\/tmp\//, /\bmkdtemp(Sync)?\s*\(/],
	},
	{
		id: "deserialize",
		title: "Deserialization and parsing of untrusted input",
		why: "Session files, settings, model output, and HTML export are all attacker-influenced.",
		patterns: [/JSON\.parse\s*\(/, /\byaml\b/i, /parseYaml/, /innerHTML/, /dangerouslySet/],
	},
	{
		id: "trust",
		title: "Trust and permission decisions",
		why: "Where the harness decides whether to run something; the CVE-2026-54325 class.",
		// No \b anchors: this codebase names trust checks in camelCase (isProjectTrusted, projectTrusted,
		// hasApproved), and \btrust cannot match the "Trust" inside "ProjectTrustStore" because the preceding
		// character is a word character. That gap hid 54 of the trust-decision sites — the guards themselves,
		// which are the most important thing in this class — so these are deliberately substring matches.
		patterns: [/trust/i, /approv/i, /permission/i, /confirm/i, /allowlist/i, /denylist/i],
	},
];

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (SKIP_DIR.has(e)) continue;
		const p = join(dir, e);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(p, out);
		else if (e.endsWith(".ts") && !SKIP_FILE.test(e)) out.push(p);
	}
	return out;
}

const files = SCOPE.flatMap((s) => walk(join(repoRoot, s)));
const hits = [];
const byClass = new Map(CLASSES.map((c) => [c.id, 0]));
const endpoints = new Map();

for (const file of files) {
	const rel = relative(repoRoot, file);
	const lines = readFileSync(file, "utf-8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip pure comment lines: they cannot execute.
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		for (const cls of CLASSES) {
			if (cls.patterns.some((p) => p.test(line))) {
				hits.push({ class: cls.id, file: rel, line: i + 1, text: trimmed.slice(0, 200) });
				byClass.set(cls.id, byClass.get(cls.id) + 1);
			}
		}
		for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
			const host = m[1].toLowerCase();
			if (host.includes("${") || host === "localhost") continue;
			if (!endpoints.has(host)) endpoints.set(host, []);
			endpoints.get(host).push(`${rel}:${i + 1}`);
		}
	}
}

const report = {
	generatedFrom: "strape/scripts/capability-sweep.mjs",
	scope: SCOPE,
	filesScanned: files.length,
	totals: Object.fromEntries(byClass),
	hostsReferenced: Object.fromEntries(
		[...endpoints.entries()].sort().map(([h, sites]) => [h, sites.slice(0, 8)]),
	),
	hits,
};

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const checkIdx = args.indexOf("--check");

if (jsonIdx !== -1) {
	const out = args[jsonIdx + 1];
	writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`Wrote ${out} (${files.length} files, ${hits.length} capability sites)`);
}

if (checkIdx !== -1) {
	const baselinePath = args[checkIdx + 1];
	const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
	const drift = [];
	for (const [cls, n] of Object.entries(report.totals)) {
		const was = baseline.totals?.[cls] ?? 0;
		if (n !== was) drift.push(`${cls}: ${was} -> ${n}`);
	}
	const newHosts = Object.keys(report.hostsReferenced).filter((h) => !baseline.hostsReferenced?.[h]);
	for (const h of newHosts) drift.push(`new host: ${h}`);
	if (drift.length) {
		console.error("Capability drift vs reviewed baseline:");
		for (const d of drift) console.error(`  ${d}`);
		console.error(
			"\nReview the new capability sites, then regenerate the baseline with --json.",
		);
		process.exit(1);
	}
	console.log(`Capability sweep matches reviewed baseline (${hits.length} sites).`);
}

if (jsonIdx === -1 && checkIdx === -1) {
	console.log(`Scanned ${files.length} files in ${SCOPE.length} packages\n`);
	for (const cls of CLASSES) {
		console.log(`${cls.title} (${cls.id}): ${byClass.get(cls.id)} sites`);
	}
	console.log("\nHosts referenced in source:");
	for (const [h, sites] of Object.entries(report.hostsReferenced)) {
		console.log(`  ${h}  <- ${sites[0]}${sites.length > 1 ? ` (+${sites.length - 1})` : ""}`);
	}
}
