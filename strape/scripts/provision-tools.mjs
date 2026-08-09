#!/usr/bin/env node
/**
 * Hash-verified provisioning of the external binaries the harness shells out to (ripgrep, fd).
 *
 * WHY THIS EXISTS
 * Upstream's packages/coding-agent/src/utils/tools-manager.ts downloads these binaries at runtime and
 * executes them, with no integrity verification at all:
 *   - the version is whatever GitHub's /releases/latest returns at that moment (tools-manager.ts:108-123)
 *   - the archive is fetched over HTTPS and extracted (tools-manager.ts:265-271)
 *   - no checksum, no signature, no pinned version is checked before the binary is spawned by the
 *     grep/find tools (core/tools/grep.ts:221, core/tools/find.ts:264)
 * This is a supply-chain path that the npm dependency review cannot see: rg/fd are not npm packages, so
 * the reviewed-deps gate and the SBOM never mention them.
 *
 * strape's posture:
 *   1. strape/bin/strape sets PI_OFFLINE=1, which makes upstream's downloader skip and fail closed
 *      (tools-manager.ts:337-343) — so nothing unverified is ever fetched by default.
 *   2. This script then installs PINNED, SHA256-VERIFIED binaries into the bin dir the harness looks in
 *      (config.ts:549 -> <agentDir>/bin), so grep/find work without weakening the posture.
 *
 * Usage:
 *   node strape/scripts/provision-tools.mjs --record    # download, print hashes, write the manifest
 *                                                       # (do this ONCE, then review provenance by hand)
 *   node strape/scripts/provision-tools.mjs             # install from the manifest, verifying sha256
 *   node strape/scripts/provision-tools.mjs --verify    # check what is installed against the manifest
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const manifestPath = join(repoRoot, "strape/audit/vendored-tools.json");

const args = new Set(process.argv.slice(2));
const record = args.has("--record");
const verifyOnly = args.has("--verify");

const AGENT_DIR = process.env.STRAPE_CODING_AGENT_DIR || join(homedir(), ".strape", "agent");
const BIN_DIR = join(AGENT_DIR, "bin");

/**
 * Pinned versions. Deliberately hardcoded, never resolved from /releases/latest: "latest" means "whatever
 * an attacker who compromised the release pipeline published five minutes ago".
 */
const PINS = {
	rg: { version: "14.1.1", repo: "BurntSushi/ripgrep", tagPrefix: "", binaryName: "rg" },
	fd: { version: "10.3.0", repo: "sharkdp/fd", tagPrefix: "v", binaryName: "fd" },
};

const assetName = (tool, version) => {
	const p = platform();
	const a = arch();
	const triple =
		p === "linux" && a === "x64" ? "x86_64-unknown-linux-musl"
		: p === "linux" && a === "arm64" ? "aarch64-unknown-linux-gnu"
		: p === "darwin" && a === "arm64" ? "aarch64-apple-darwin"
		: p === "darwin" && a === "x64" ? "x86_64-apple-darwin"
		: p === "win32" && a === "x64" ? "x86_64-pc-windows-msvc"
		: null;
	if (!triple) return null;
	const ext = p === "win32" ? "zip" : "tar.gz";
	const base = tool === "rg" ? `ripgrep-${version}-${triple}` : `fd-v${version}-${triple}`;
	return { file: `${base}.${ext}`, dir: base, ext };
};

const platformKey = `${platform()}-${arch()}`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const loadManifest = () =>
	existsSync(manifestPath)
		? JSON.parse(readFileSync(manifestPath, "utf-8"))
		: {
				$comment:
					"Pinned, hash-verified external binaries (rg/fd). Upstream downloads these unverified at runtime; strape does not. Hashes are per platform archive. reviewedBy/reviewedAt must be filled by a human who checked provenance.",
				tools: {},
			};

const download = async (url) => {
	const res = await fetch(url, { headers: { "User-Agent": "strape-provision-tools" }, redirect: "follow" });
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
};

const extractAndInstall = (buf, tool, asset) => {
	const tmp = mkdtempSync(join(tmpdir(), "strape-tools-"));
	try {
		const archivePath = join(tmp, asset.file);
		writeFileSync(archivePath, buf);
		if (asset.ext === "tar.gz") {
			execFileSync("tar", ["-xzf", archivePath, "-C", tmp], { stdio: "pipe" });
		} else {
			execFileSync("unzip", ["-q", archivePath, "-d", tmp], { stdio: "pipe" });
		}
		const wanted = PINS[tool].binaryName + (platform() === "win32" ? ".exe" : "");
		const find = (dir) => {
			for (const e of readdirSync(dir)) {
				const p = join(dir, e);
				if (statSync(p).isDirectory()) {
					const hit = find(p);
					if (hit) return hit;
				} else if (e === wanted) return p;
			}
			return null;
		};
		const src = find(tmp);
		if (!src) throw new Error(`binary ${wanted} not found inside ${asset.file}`);
		mkdirSync(BIN_DIR, { recursive: true });
		const dest = join(BIN_DIR, wanted);
		copyFileSync(src, dest);
		chmodSync(dest, 0o755);
		return { dest, binarySha256: sha256(readFileSync(dest)) };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
};

const manifest = loadManifest();

if (verifyOnly) {
	let bad = 0;
	for (const [tool, pin] of Object.entries(PINS)) {
		const wanted = pin.binaryName + (platform() === "win32" ? ".exe" : "");
		const installed = join(BIN_DIR, wanted);
		const expected = manifest.tools?.[tool]?.platforms?.[platformKey]?.binarySha256;
		if (!existsSync(installed)) {
			console.log(`  ----  ${tool}: not installed at ${installed}`);
			continue;
		}
		const actual = sha256(readFileSync(installed));
		if (!expected) {
			console.log(`  ----  ${tool}: installed but no recorded hash for ${platformKey} (${actual.slice(0, 16)}…)`);
			continue;
		}
		if (actual === expected) console.log(`  ok    ${tool} ${pin.version} matches manifest`);
		else {
			console.error(`  FAIL  ${tool}: installed binary hash ${actual.slice(0, 16)}… != manifest ${expected.slice(0, 16)}…`);
			bad++;
		}
	}
	process.exit(bad ? 1 : 0);
}

for (const [tool, pin] of Object.entries(PINS)) {
	const asset = assetName(tool, pin.version);
	if (!asset) {
		console.log(`  ----  ${tool}: unsupported platform ${platformKey}; install ${pin.binaryName} via your package manager`);
		continue;
	}
	const url = `https://github.com/${pin.repo}/releases/download/${pin.tagPrefix}${pin.version}/${asset.file}`;
	const recorded = manifest.tools?.[tool]?.platforms?.[platformKey];

	if (!record && !recorded) {
		console.error(
			`  FAIL  ${tool}: no recorded hash for ${platformKey} in ${manifestPath}.\n` +
				"        Refusing to install an unverified binary. Run with --record on a trusted machine,\n" +
				"        verify provenance by hand, then commit the manifest.",
		);
		process.exitCode = 1;
		continue;
	}

	const buf = await download(url);
	const archiveSha = sha256(buf);

	if (!record) {
		if (archiveSha !== recorded.archiveSha256) {
			console.error(
				`  FAIL  ${tool}: archive hash mismatch — expected ${recorded.archiveSha256.slice(0, 16)}…, got ${archiveSha.slice(0, 16)}…\n` +
					"        The pinned release was republished or tampered with. Do NOT install. Investigate.",
			);
			process.exitCode = 1;
			continue;
		}
	}

	const { dest, binarySha256 } = extractAndInstall(buf, tool, asset);

	if (record) {
		manifest.tools[tool] ??= { version: pin.version, repo: pin.repo, platforms: {} };
		manifest.tools[tool].version = pin.version;
		manifest.tools[tool].repo = pin.repo;
		manifest.tools[tool].platforms[platformKey] = {
			asset: asset.file,
			url,
			archiveSha256: archiveSha,
			binarySha256,
			recordedBy: null,
			recordedAt: null,
		};
		console.log(`  rec   ${tool} ${pin.version} (${platformKey})`);
		console.log(`        archive sha256 ${archiveSha}`);
		console.log(`        binary  sha256 ${binarySha256}`);
	} else if (binarySha256 !== recorded.binarySha256) {
		console.error(`  FAIL  ${tool}: extracted binary hash differs from manifest — archive matched but contents did not.`);
		process.exitCode = 1;
	} else {
		console.log(`  ok    ${tool} ${pin.version} verified and installed -> ${dest}`);
	}
}

if (record) {
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`\nWrote ${manifestPath}.`);
	console.log("A human must now verify provenance (release page, expected hashes) and fill recordedBy/recordedAt.");
}
