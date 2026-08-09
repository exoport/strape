#!/usr/bin/env node
/**
 * Fetch osv-scanner, pinned by version and verified by sha256.
 *
 * The scanner is 56MB, so it is not committed — but a security tool fetched without verification is worse
 * than no tool, so the hash is committed and checked before the binary is ever made executable.
 *
 * The pinned hash below was cross-checked against the digest GitHub publishes in its own release asset
 * metadata (api.github.com/repos/google/osv-scanner/releases/latest -> assets[].digest), which is an
 * independent source from the download itself.
 *
 * Usage:
 *   node strape/scripts/fetch-osv.mjs            # fetch + verify into strape/tools/
 *   node strape/scripts/fetch-osv.mjs --verify   # verify an existing binary only
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { platform, arch } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const toolsDir = join(repoRoot, "strape/tools");
const dest = join(toolsDir, "osv-scanner");
const hashFile = join(toolsDir, "osv-scanner.sha256");

const VERSION = "v2.4.0";
/** sha256 per platform asset, verified against GitHub's published asset digests. */
const PINS = {
	"linux-x64": {
		asset: "osv-scanner_linux_amd64",
		sha256: "15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0",
	},
	"linux-arm64": {
		asset: "osv-scanner_linux_arm64",
		sha256: "44e580752910f0ff36ec99aff59af20f65df1e859aa31e5605a8f0d055b496e9",
	},
};

const key = `${platform()}-${arch()}`;
const pin = PINS[key];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

if (process.argv.includes("--verify")) {
	if (!existsSync(dest)) {
		console.error(`${dest} not present. Run: node strape/scripts/fetch-osv.mjs`);
		process.exit(1);
	}
	const actual = sha256(readFileSync(dest));
	const expected = pin?.sha256 ?? readFileSync(hashFile, "utf-8").trim().split(/\s+/)[0];
	if (actual !== expected) {
		console.error(`osv-scanner hash mismatch: ${actual} != ${expected}`);
		process.exit(1);
	}
	console.log(`osv-scanner ${VERSION} verified (${actual.slice(0, 16)}…)`);
	process.exit(0);
}

if (!pin) {
	console.error(`No pinned osv-scanner hash for ${key}. Add one after verifying GitHub's asset digest.`);
	process.exit(1);
}

const url = `https://github.com/google/osv-scanner/releases/download/${VERSION}/${pin.asset}`;
console.log(`Fetching ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
	console.error(`HTTP ${res.status} fetching osv-scanner`);
	process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const actual = sha256(buf);
if (actual !== pin.sha256) {
	console.error(
		`REFUSING TO INSTALL: sha256 mismatch\n  expected ${pin.sha256}\n  got      ${actual}\n` +
			"The pinned release was republished or the download was tampered with.",
	);
	process.exit(1);
}

mkdirSync(toolsDir, { recursive: true });
writeFileSync(dest, buf);
chmodSync(dest, 0o755);
writeFileSync(hashFile, `${pin.sha256}  osv-scanner\n`);
console.log(`osv-scanner ${VERSION} verified and installed -> ${dest}`);
console.log(`Scan with: strape/tools/osv-scanner scan source --lockfile=package-lock.json`);
