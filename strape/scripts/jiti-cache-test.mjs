#!/usr/bin/env node
/**
 * Regression test for hunk 14: jiti's transpile cache must not live in /tmp.
 *
 * WHAT WAS WRONG
 * `createJiti` was called with only `{ moduleCache: false }`, so `fsCache` kept its default: ON, and pointed
 * at `os.tmpdir()/jiti`. jiti writes TRANSPILED EXTENSION CODE there with umask-derived permissions (observed
 * 775 dirs / 664 files under a world-writable /tmp) and later re-executes it through `vm.runInThisContext`
 * when a content-hash marker matches. Any local principal able to pre-create or write into that directory can
 * therefore plant code strape executes with the developer's provider keys. Found by the dependency review's
 * adversarial pass on jiti (dep-review-v0.84.0.md §3).
 *
 * WHY IT IS TESTED BY LOADING A REAL EXTENSION
 * The cache is a side effect of `createJiti`, so asserting on the option value would only prove the literal we
 * just wrote is still there. These assertions run `loadExtensions()` — the real entry point — against a real
 * .ts extension and then look at the filesystem: cache bytes must appear under the agent dir and must NOT
 * appear in /tmp/jiti. That distinction is the whole point of the hunk.
 *
 * Requires a build (npm run build:offline). Writes only to a temp dir.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distLoader = join(repoRoot, "packages/coding-agent/dist/core/extensions/loader.js");

const results = [];
const check = (name, ok, detail) => results.push({ ok, name, detail });

const countFiles = (dir) => {
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		n += entry.isDirectory() ? countFiles(p) : 1;
	}
	return n;
};

const root = mkdtempSync(join(tmpdir(), "strape-jiti-cache-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(projectDir, { recursive: true });

// A .ts extension forces transpilation, which is what populates the cache.
const extensionPath = join(projectDir, "probe-extension.ts");
writeFileSync(
	extensionPath,
	`interface Probe { name: string }\nexport default function (): Probe { return { name: "probe" }; }\n`,
);

// Point the agent dir at the temp tree BEFORE importing, since getAgentDir() reads the environment.
process.env.STRAPE_CODING_AGENT_DIR = agentDir;

const tmpJitiDir = join(tmpdir(), "jiti");
const tmpJitiBefore = countFiles(tmpJitiDir);

try {
	// Mirror real startup order: main() calls ensureAgentDirPermissions(agentDir) (hunk 12) before anything
	// reads or writes there. Hunk 14 relies on that — it puts the cache inside a private tree rather than
	// hardening the cache itself, exactly as sessions/ and bin/ are protected by the parent alone. Skipping
	// this step here would test a composition that never occurs in a real run.
	const { ensureAgentDirPermissions } = await import(`file://${join(repoRoot, "packages/coding-agent/dist/config.js")}`);
	ensureAgentDirPermissions(agentDir);

	const { loadExtensions } = await import(`file://${distLoader}`);
	await loadExtensions([extensionPath], projectDir);

	const cacheDir = join(agentDir, "cache", "jiti");
	const cachedUnderAgentDir = countFiles(cacheDir);
	const tmpJitiAfter = countFiles(tmpJitiDir);

	check(
		"the transpile cache lands under the agent dir",
		cachedUnderAgentDir > 0,
		cachedUnderAgentDir > 0 ? `${cachedUnderAgentDir} file(s) in ${cacheDir}` : `nothing written to ${cacheDir}`,
	);
	check(
		"...and nothing new is written to /tmp/jiti",
		tmpJitiAfter === tmpJitiBefore,
		`/tmp/jiti went ${tmpJitiBefore} -> ${tmpJitiAfter}`,
	);
	// The parent is what protects the cache: hunk 12 creates and repairs the agent dir as 0700, so the leaves
	// jiti creates inside it need no mode dance of their own. Assert the property the hunk actually relies on.
	if (process.platform !== "win32" && existsSync(agentDir)) {
		const mode = statSync(agentDir).mode & 0o777;
		check("the agent dir protecting it is not group- or world-accessible", (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
	}
	// jiti call-site guarantee #2 (dep-review-v0.84.0.md §2). The adversarial pass showed dist/babel.cjs's
	// transform() spreads a caller-supplied `...r.babel` AFTER the safe defaults, so babelrc/configFile/cwd are
	// all overridable through the public JitiOptions.transformOptions.babel field — only `plugins` is actually
	// protected. Nothing in strape sets transformOptions today, so a hostile repo cannot hijack the compiler
	// via its own babel.config.js. But that is a property of OUR call sites, not an invariant of the package,
	// so it needs pinning: if a transformOptions appears, a human must confirm no repo-controlled data reaches
	// it before this assertion is relaxed.
	const sources = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.name.endsWith(".ts")) sources.push(p);
		}
	};
	for (const pkg of ["coding-agent", "ai", "agent", "tui"]) walk(join(repoRoot, "packages", pkg, "src"));
	const withTransformOptions = sources.filter((f) => readFileSync(f, "utf-8").includes("transformOptions"));
	check(
		"no call site threads data into jiti's transformOptions",
		withTransformOptions.length === 0,
		withTransformOptions.length === 0
			? `${sources.length} source files scanned, 0 occurrences`
			: `found in: ${withTransformOptions.map((f) => f.slice(repoRoot.length + 1)).join(", ")}`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("strape jiti cache location (hunk 14)\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: transpiled extension code is not where it should be.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
