#!/usr/bin/env node
/**
 * Regression test for hunk 12: the agent directory must not be group- or world-accessible.
 *
 * Upstream creates `~/.strape` and `~/.strape/agent` from four different writers, all with the ambient
 * umask: `core/trust-manager.ts`, `core/settings-manager.ts`, `core/session-manager.ts` (recursively, so it
 * creates the parents too) and `migrations.ts`. That is 0755 at umask 022 and **0775 at umask 002**, which
 * is the default on Debian/Ubuntu and in many container images. User-scope extensions load from that
 * directory with no trust gate, so on a umask-002 machine another local account can drop in an extension
 * that runs on the next start.
 *
 * `config.ts ensureAgentDirPermissions()` creates the directories 0700 and repairs pre-existing ones, and
 * `main()` calls it before anything reads or writes there.
 *
 * Requires a build (npm run build:offline). No network, no LLM, no API key. Writes only to a temp dir —
 * it never touches your real ~/.strape.
 */

import { mkdtempSync, mkdirSync, statSync, chmodSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distConfig = join(repoRoot, "packages/coding-agent/dist/config.js");

if (process.platform === "win32") {
	console.log("strape agent-dir permissions (hunk 12)\n\n  skipped — POSIX modes do not apply on Windows");
	process.exit(0);
}

let ensureAgentDirPermissions;
let CONFIG_DIR_NAME;
try {
	({ ensureAgentDirPermissions, CONFIG_DIR_NAME } = await import(`file://${distConfig}`));
} catch (e) {
	console.error(`Cannot import ${distConfig}: ${e.message}\nBuild first: npm run build:offline`);
	process.exit(1);
}

const results = [];
const check = (name, actual, expected, detail) => {
	const ok = actual === expected;
	results.push({ ok, name, detail: detail ?? `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` });
};
const mode = (path) => statSync(path).mode & 0o777;
const asOctal = (n) => `0${n.toString(8)}`;

const root = mkdtempSync(join(tmpdir(), "strape-perms-"));
const realHome = process.env.HOME;

try {
	/* 1-2. A pre-existing directory is repaired, at both umasks that matter. 0775 is the one that actually
	        bites: it is what umask 002 produces, and it lets any member of the user's group write. */
	for (const start of [0o775, 0o755]) {
		const dir = join(root, `existing-${start.toString(8)}`);
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, start);
		ensureAgentDirPermissions(dir);
		check(
			`pre-existing ${asOctal(start)} agent dir is repaired to 0700`,
			mode(dir),
			0o700,
			`${asOctal(start)} -> ${asOctal(mode(dir))}`,
		);
	}

	/* 3. A missing directory is created closed, even under a permissive umask. mkdir applies mode & ~umask,
	      so this also proves 0700 survives umask 002 (0700 & ~0o002 is still 0700). */
	const previousUmask = process.umask(0o002);
	try {
		const fresh = join(root, "fresh", "agent");
		ensureAgentDirPermissions(fresh);
		check("missing agent dir is created 0700 under umask 002", mode(fresh), 0o700, `created ${asOctal(mode(fresh))}`);
	} finally {
		process.umask(previousUmask);
	}

	/* 4. Idempotent: an already-correct directory is left alone and the call does not throw. */
	const correct = join(root, "already-correct");
	mkdirSync(correct, { mode: 0o700, recursive: true });
	ensureAgentDirPermissions(correct);
	ensureAgentDirPermissions(correct);
	check("an already-0700 dir stays 0700 across repeated calls", mode(correct), 0o700, asOctal(mode(correct)));

	/* 5. The parent is hardened ONLY at the default location. This is the assertion that stops a future
	      "harden the parent too" simplification from chmodding a directory the user chose for other
	      reasons — STRAPE_CODING_AGENT_DIR=~/work/agent must not make ~/work private. */
	const customParent = join(root, "custom-parent");
	const customAgentDir = join(customParent, "agent");
	mkdirSync(customAgentDir, { recursive: true });
	chmodSync(customParent, 0o755);
	chmodSync(customAgentDir, 0o755);
	ensureAgentDirPermissions(customAgentDir);
	check("a custom agent dir is hardened", mode(customAgentDir), 0o700, asOctal(mode(customAgentDir)));
	check(
		"but its parent is left alone",
		mode(customParent),
		0o755,
		`${asOctal(mode(customParent))} (must stay 0755 — the user chose this location)`,
	);

	/* 6. At the default location the parent IS hardened, because ~/.strape is ours: it holds trust.json and
	      auth.json alongside the agent dir. Driven through a fake HOME, since os.homedir() reads $HOME. */
	const fakeHome = join(root, "home");
	mkdirSync(fakeHome, { recursive: true });
	process.env.HOME = fakeHome;
	if (homedir() !== fakeHome) {
		results.push({
			ok: false,
			name: "fake HOME took effect",
			detail: `homedir() = ${homedir()}, expected ${fakeHome} — cannot test the default-location branch`,
		});
	} else {
		const defaultConfigDir = join(fakeHome, CONFIG_DIR_NAME);
		const defaultAgentDir = join(defaultConfigDir, "agent");
		mkdirSync(defaultAgentDir, { recursive: true });
		chmodSync(defaultConfigDir, 0o755);
		chmodSync(defaultAgentDir, 0o755);
		ensureAgentDirPermissions(defaultAgentDir);
		check(
			`~/${CONFIG_DIR_NAME} is hardened at the default location`,
			mode(defaultConfigDir),
			0o700,
			`${CONFIG_DIR_NAME} is ${asOctal(mode(defaultConfigDir))}`,
		);
		check(
			`~/${CONFIG_DIR_NAME}/agent is hardened at the default location`,
			mode(defaultAgentDir),
			0o700,
			asOctal(mode(defaultAgentDir)),
		);
	}
	process.env.HOME = realHome;

	/* 7. A failure must never stop the agent from starting: a read-only parent produces a warning, not a
	      throw. Skipped when running as root, where the write succeeds regardless of mode. */
	if (typeof process.getuid === "function" && process.getuid() !== 0) {
		const locked = join(root, "locked");
		mkdirSync(locked, { recursive: true });
		chmodSync(locked, 0o500);
		let threw = false;
		try {
			ensureAgentDirPermissions(join(locked, "agent"));
		} catch {
			threw = true;
		}
		chmodSync(locked, 0o700);
		check("an unwritable location warns instead of throwing", threw, false, threw ? "THREW" : "warned and continued");
		check(
			"and it did not silently succeed",
			existsSync(join(locked, "agent")),
			false,
			"the dir really could not be created, so the warning path was the one exercised",
		);
	}

	/* 8. Source pin: main() must still call it, and before the first settings read. Assertions 1-7 drive the
	      exported function directly, so they would all pass on a tree where the call site was reverted. */
	const mainSrc = readFileSync(join(repoRoot, "packages/coding-agent/src/main.ts"), "utf-8");
	const callAt = mainSrc.indexOf("ensureAgentDirPermissions(agentDir);");
	const firstReadAt = mainSrc.indexOf("SettingsManager.create(cwd, agentDir, { projectTrusted: false })");
	check(
		"main() hardens the agent dir before the first read",
		callAt > 0 && firstReadAt > 0 && callAt < firstReadAt,
		true,
		callAt < 0 ? "MISSING — hunk 12 was reverted by a merge" : "called before the bootstrap SettingsManager",
	);
} finally {
	process.env.HOME = realHome;
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		/* a 0500 dir may survive; the temp dir cleans itself up eventually */
	}
}

console.log("strape agent-dir permissions (hunk 12)\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: the agent directory is not private.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
