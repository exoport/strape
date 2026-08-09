#!/usr/bin/env node
/**
 * Pinned, hash-verified fetch for the security tools strape uses but does not commit.
 *
 * A security tool downloaded without verification is worse than no tool: it runs with your privileges and you
 * trust its output. So every binary here is pinned to a version AND a sha256 that was cross-checked against
 * the digest GitHub publishes in its own release-asset metadata — an independent source from the download.
 *
 * Generalises what fetch-osv.mjs did for one tool. osv-scanner stays in its own script so existing CI keeps
 * working; new tools go here.
 *
 * Usage:
 *   node strape/scripts/fetch-tool.mjs syft
 *   node strape/scripts/fetch-tool.mjs cosign
 *   node strape/scripts/fetch-tool.mjs --all
 *   node strape/scripts/fetch-tool.mjs --verify
 */

import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, mkdtempSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const toolsDir = join(repoRoot, "strape/tools");

/**
 * Hashes verified against each project's GitHub release-asset digest on 2026-08-07.
 * To add a platform: read the digest from
 *   api.github.com/repos/<org>/<repo>/releases/tags/<tag> -> assets[].digest
 * and record it here. Never record a hash you computed only from your own download.
 */
const TOOLS = {
	syft: {
		version: "v1.50.0",
		repo: "anchore/syft",
		binary: "syft",
		assets: {
			"linux-x64": { name: "syft_1.50.0_linux_amd64.tar.gz", sha256: "bf7b29ff57f06da30918266a0e1c2885a8f99784798d1bdb1628886aa015d788", archive: "tar.gz" },
		},
	},
	cosign: {
		version: "v3.1.3",
		repo: "sigstore/cosign",
		binary: "cosign",
		assets: {
			"linux-x64": { name: "cosign-linux-amd64", sha256: "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71", archive: "raw" },
		},
	},
};

const key = `${platform()}-${arch()}`;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const wanted = args.includes("--all") ? Object.keys(TOOLS) : args.filter((a) => !a.startsWith("--"));
const verifyOnly = args.includes("--verify");

if (verifyOnly) {
	let bad = 0;
	for (const [name, spec] of Object.entries(TOOLS)) {
		const dest = join(toolsDir, spec.binary);
		const hashFile = `${dest}.sha256`;
		if (!existsSync(dest)) {
			console.log(`  ----  ${name}: not installed`);
			continue;
		}
		if (!existsSync(hashFile)) {
			console.error(`  FAIL  ${name}: installed with no recorded hash file`);
			bad++;
			continue;
		}
		const expected = readFileSync(hashFile, "utf-8").trim().split(/\s+/)[0];
		const actual = sha256(readFileSync(dest));
		if (actual === expected) console.log(`  ok    ${name} ${spec.version} matches its recorded hash`);
		else {
			console.error(`  FAIL  ${name}: ${actual.slice(0, 16)}… != ${expected.slice(0, 16)}…`);
			bad++;
		}
	}
	process.exit(bad ? 1 : 0);
}

if (!wanted.length) {
	console.error(`Usage: fetch-tool.mjs [${Object.keys(TOOLS).join("|")}] | --all | --verify`);
	process.exit(2);
}

for (const name of wanted) {
	const spec = TOOLS[name];
	if (!spec) {
		console.error(`Unknown tool "${name}". Known: ${Object.keys(TOOLS).join(", ")}`);
		process.exitCode = 1;
		continue;
	}
	const asset = spec.assets[key];
	if (!asset) {
		console.error(`  FAIL  ${name}: no pinned hash for ${key}. Record one from GitHub's asset digest first.`);
		process.exitCode = 1;
		continue;
	}
	const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${asset.name}`;
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) {
		console.error(`  FAIL  ${name}: HTTP ${res.status} for ${url}`);
		process.exitCode = 1;
		continue;
	}
	const buf = Buffer.from(await res.arrayBuffer());
	const actual = sha256(buf);
	if (actual !== asset.sha256) {
		console.error(
			`  FAIL  ${name}: REFUSING TO INSTALL — sha256 mismatch\n        expected ${asset.sha256}\n        got      ${actual}`,
		);
		process.exitCode = 1;
		continue;
	}

	mkdirSync(toolsDir, { recursive: true });
	const dest = join(toolsDir, spec.binary);

	if (asset.archive === "raw") {
		writeFileSync(dest, buf);
	} else {
		const tmp = mkdtempSync(join(tmpdir(), `strape-tool-${name}-`));
		try {
			const arch_ = join(tmp, asset.name);
			writeFileSync(arch_, buf);
			execFileSync("tar", ["-xzf", arch_, "-C", tmp], { stdio: "pipe" });
			const find = (dir) => {
				for (const e of readdirSync(dir)) {
					const p = join(dir, e);
					if (statSync(p).isDirectory()) {
						const hit = find(p);
						if (hit) return hit;
					} else if (e === spec.binary) return p;
				}
				return null;
			};
			const src = find(tmp);
			if (!src) throw new Error(`binary ${spec.binary} not found in ${asset.name}`);
			copyFileSync(src, dest);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	chmodSync(dest, 0o755);
	writeFileSync(`${dest}.sha256`, `${sha256(readFileSync(dest))}  ${spec.binary}\n`);
	console.log(`  ok    ${name} ${spec.version} verified (archive sha256 matched GitHub's published digest) -> ${dest}`);
}
