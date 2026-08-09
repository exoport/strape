#!/usr/bin/env node
/**
 * Regression test for the GuardDog gate's failure handling.
 *
 * WHY THIS EXISTS
 * `guarddog-scan.mjs --check` records a per-package tool failure as `status: "scan-error"` with no threats
 * and a null risk score. Until 2026-08-08 the check path compared only threats and risk scores, so those
 * rows passed every comparison and the gate printed "No new threat rules or risk-score increases" and
 * exited 0 — over zero coverage. It was found in exactly that state: a repo move had left the venv's
 * shebang pointing at the old absolute path, so all 42 packages errored and the gate stayed green.
 *
 * That is not a hypothetical failure mode. GuardDog is the one tool in `strape-security.yml` installed
 * unpinned from PyPI (`pip install guarddog`), so a renamed flag on `guarddog npm scan` in any routine
 * release breaks every package at once — and a silently-vacuous gate is worse than no gate, because it
 * reads as coverage.
 *
 * WHAT IS PINNED
 * Both directions, because a guard that only fails closed is half-tested: a broken tool must fail the
 * gate, and a working tool that legitimately finds nothing must still pass it.
 *
 * Needs `npm ci --ignore-scripts` (it scans the installed shipped closure) but no build, no network, no
 * API key, and never invokes the real GuardDog — every case is driven by a stub in a temp dir.
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const scanner = join(repoRoot, "strape/scripts/guarddog-scan.mjs");
const baselinePath = join(repoRoot, "strape/audit/guarddog-v0.84.0.json");

if (process.platform === "win32") {
	console.log("strape guarddog gate\n\n  skipped — the stubs are POSIX shell scripts");
	process.exit(0);
}

// The stand-aside case is only meaningful if there is something to scan; without node_modules every package
// is "not-installed" and a clean run would look identical to a broken one.
const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
const installed = (baseline.packages ?? []).filter((p) => existsSync(join(repoRoot, p.path)));
if (installed.length === 0) {
	console.error("No shipped-closure packages are installed. Run: npm ci --ignore-scripts --no-audit --no-fund");
	process.exit(1);
}

const results = [];
const check = (name, ok, detail) => results.push({ ok, name, detail });

const root = mkdtempSync(join(tmpdir(), "strape-guarddog-gate-"));
const stub = (name, body) => {
	const p = join(root, name);
	writeFileSync(p, body);
	chmodSync(p, 0o755);
	return p;
};
const emits = (json) => `#!/bin/sh\necho '${json}'\n`;

const run = (bin) => {
	try {
		const out = execFileSync(process.execPath, [scanner, "--check", baselinePath], {
			encoding: "utf-8",
			env: { ...process.env, STRAPE_GUARDDOG_BIN: bin },
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
};

try {
	// 1. The real-world failure: the binary is present, but every invocation of it fails.
	const broken = run(stub("guarddog-broken", "#!/bin/sh\nexit 3\n"));
	check("a tool that fails on every package fails the gate", broken.code !== 0, `exit ${broken.code}`);
	check(
		"...and reports it as lost coverage, not a clean scan",
		/coverage regression/.test(broken.out),
		broken.out.match(/coverage regression/) ? "names the regression per package" : "MISSING — a scan error reads as clean",
	);
	check(
		"...and names the zero-coverage case explicitly",
		/did not run at all/.test(broken.out),
		/did not run at all/.test(broken.out) ? "backstop fired" : "MISSING — nothing scanned, yet no complaint",
	);

	// 2. Stand-aside: a working tool that finds nothing must still pass, with real coverage behind it.
	const clean = run(stub("guarddog-clean", emits('{"results":{},"risk_score":{"score":0,"label":"no_risks_detected"}}')));
	check("a clean scan still passes", clean.code === 0, `exit ${clean.code}`);
	const scannedCount = Number(clean.out.match(/guarddog check: (\d+) scanned/)?.[1] ?? 0);
	check("...having actually scanned the closure", scannedCount === installed.length, `${scannedCount} scanned, ${installed.length} installed`);

	// 3. The gate's original purpose must survive the fix: a threat rule the baseline does not carry.
	const threat = run(
		stub("guarddog-threat", emits('{"results":{"threat-exfiltrate-sensitive-data":[{"location":"index.js","match":"x"}]},"risk_score":{"score":0,"label":"x"}}')),
	);
	check("a NEW threat rule fails the gate", threat.code !== 0 && /NEW threat rule/.test(threat.out), `exit ${threat.code}`);

	// 4. Same for a risk score above what was reviewed.
	const risky = run(stub("guarddog-risky", emits('{"results":{},"risk_score":{"score":9.5,"label":"high"}}')));
	check("a risk-score increase fails the gate", risky.code !== 0 && /risk score/.test(risky.out), `exit ${risky.code}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("strape guarddog gate\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: the GuardDog gate can report success without coverage.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
