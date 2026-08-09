#!/usr/bin/env node
/**
 * Merge-safety invariant checker.
 *
 * strape's entire divergence from upstream pi is ten small hunks in upstream-owned files. A `git merge
 * upstream/<tag>` can silently revert any of them (upstream rewrites the line, git takes "theirs", nobody
 * notices). This script asserts every hunk is still in place, and fails loudly if not.
 *
 * Enforced in CI on every push (.github/workflows/strape-build.yml). Deliberately NOT wired into
 * .husky/pre-commit: that file is upstream-owned, and editing it would add another hunk to maintain for a
 * check CI already performs. To run it locally on every commit anyway, add it to your own hook — that is a
 * personal choice, not tracked divergence.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const read = (p) => readFileSync(join(repoRoot, p), "utf-8");
const json = (p) => JSON.parse(read(p));

const failures = [];
const passes = [];
const check = (name, fn) => {
	try {
		const detail = fn();
		passes.push(`${name}${detail ? ` — ${detail}` : ""}`);
	} catch (e) {
		failures.push(`${name}: ${e.message}`);
	}
};

/** Hunk 1 — the rebrand seam (config.ts:487-496 derives everything from these). */
check("hunk1: piConfig + bin rebrand", () => {
	const pkg = json("packages/coding-agent/package.json");
	if (pkg.piConfig?.name !== "strape") throw new Error(`piConfig.name = ${pkg.piConfig?.name}`);
	if (pkg.piConfig?.configDir !== ".strape") throw new Error(`piConfig.configDir = ${pkg.piConfig?.configDir}`);
	if (!pkg.bin?.strape) throw new Error(`bin.strape missing (bin = ${JSON.stringify(pkg.bin)})`);
	if (pkg.bin?.pi) throw new Error("bin.pi is back — upstream bin name reintroduced");
	return "name=strape configDir=.strape bin.strape";
});

/** Hunk 2 — example-extension workspaces dropped (removes ssh2/cpu-features native deps). */
check("hunk2: example-extension workspaces removed", () => {
	const pkg = json("package.json");
	const bad = (pkg.workspaces || []).filter((w) => w.includes("examples/extensions"));
	if (bad.length) throw new Error(`example workspaces present: ${bad.join(", ")}`);
	return `${pkg.workspaces.length} workspace globs`;
});

/**
 * Hunk 3 — identity strings that piConfig does not parameterise.
 *
 * The piConfig seam (config.ts:487-496) only reaches strings upstream actually wrote as `${APP_NAME}` /
 * `${APP_TITLE}`. Everything below was a bare literal, so a rebranded build told users — and the model —
 * that it was pi. Every one was found by a person reading real output; no gate produced any of them, which
 * is exactly why they are asserted here now.
 *
 * One assertion per site, so a merge that reverts a single line names that line.
 */
const IDENTITY_STRINGS = [
	// [file, must-not-contain (RegExp), must-contain (RegExp), what it is]
	[
		"packages/coding-agent/src/core/system-prompt.ts",
		/inside pi,|Pi documentation|\bpi docs\b|\bpi packages\b|\bpi topics\b|\bpi \.md\b/,
		/inside strape,/,
		"system prompt (behavioural — this is what the model is told it is)",
	],
	[
		// Moved here by upstream v0.84.1, which split the auth CLI out of credential-print.ts into a new file
		// and re-hardcoded "pi auth" in it — the merge kept our rebrand and silently lost nothing only because
		// this invariant failed and pointed at the new location. Exactly the class hunk 3 exists to catch.
		"packages/coding-agent/src/cli/auth-command.ts",
		/\bpi auth\b/,
		/\$\{APP_NAME\} auth print-api-key/,
		"auth usage table, help block, unknown-subcommand error",
	],
	[
		"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		/`Pi can explain its own features|restart pi\.|Restart pi |"pi exiting due to|outside pi\.|\bPi works best\b/,
		/\$\{APP_TITLE\} can explain its own features/,
		"startup hint, trust banner, /trust confirmation, crash notice, auth dialog, tmux hint",
	],
	[
		"packages/coding-agent/src/cli/args.ts",
		/Update pi,/,
		/\$\{APP_NAME\} update \[source\|self\]/,
		"top-level --help command table",
	],
	[
		"packages/coding-agent/src/core/project-trust.ts",
		/This allows pi to load/,
		/This allows \$\{APP_NAME\} to load/,
		"the trust prompt itself",
	],
	[
		"packages/coding-agent/src/main.ts",
		/using "pi -ne"/,
		/using "\$\{APP_NAME\} -ne"/,
		"extension-load failure hint",
	],
	[
		"packages/coding-agent/src/package-manager-cli.ts",
		/Update pi\b|Reinstall pi\b|Location of pi executable/,
		/Update \$\{APP_NAME\}, installed packages/,
		"update help + self-update diagnostics",
	],
];
for (const [file, forbidden, required, what] of IDENTITY_STRINGS) {
	check(`hunk3: ${file.split("/").pop()} — ${what}`, () => {
		const src = read(file);
		// Strip comments: an internal note may legitimately describe upstream's behaviour using upstream's name.
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const hit = code.match(forbidden);
		if (hit) throw new Error(`upstream identity string is back: "${hit[0]}"`);
		if (!required.test(src)) throw new Error(`rebranded form missing (expected ${required})`);
		return "rebranded";
	});
}

/** Hunk 4 — unused provider SDKs must not be production deps (143 -> 56 shipped packages). */
const TRIMMED_SDKS = [
	"@anthropic-ai/sdk",
	"@aws-sdk/client-bedrock-runtime",
	"@smithy/node-http-handler",
	"@google/genai",
	"@mistralai/mistralai",
];
check("hunk4: provider SDKs are dev-only", () => {
	const pkg = json("packages/ai/package.json");
	const leaked = TRIMMED_SDKS.filter((d) => pkg.dependencies?.[d]);
	if (leaked.length) throw new Error(`back in dependencies: ${leaked.join(", ")}`);
	const missing = TRIMMED_SDKS.filter((d) => !pkg.devDependencies?.[d]);
	if (missing.length) throw new Error(`not in devDependencies (build/test will break): ${missing.join(", ")}`);
	return `${TRIMMED_SDKS.length} SDKs dev-only`;
});

/** Hunk 5 — an empty allowlist means any new lifecycle-script dep is a hard build failure. */
check("hunk5: install-script allowlist is empty", () => {
	for (const f of [
		"scripts/generate-coding-agent-shrinkwrap.mjs",
		"scripts/generate-coding-agent-install-lock.mjs",
	]) {
		const src = read(f);
		const m = src.match(/allowedInstallScriptPackages\s*=\s*new Map\(\[([\s\S]*?)\]\)/);
		if (!m) throw new Error(`${f}: allowedInstallScriptPackages declaration not found (upstream refactor?)`);
		if (m[1].trim() !== "") throw new Error(`${f}: allowlist is non-empty: ${m[1].trim().slice(0, 120)}`);
	}
	return "both generators";
});

/**
 * Hunk 6b — the .claude/skills negation must actually work. `.claude/` (a directory pattern) cannot be
 * negated from inside, because git never descends into an excluded directory: a new SKILL.md would be
 * silently ignored and never committed. `.claude/*` lets the negation apply. Found by rebuilding the tree
 * from a fresh upstream clone and noticing two files did not come back.
 */
check("hunk6b: .claude/skills is re-includable", () => {
	const gi = read(".gitignore");
	if (/^\.claude\/$/m.test(gi)) {
		throw new Error(".gitignore uses `.claude/` — a negation inside it cannot work; use `.claude/*`");
	}
	if (!/^\.claude\/\*$/m.test(gi)) throw new Error(".gitignore is missing the `.claude/*` line");
	if (!/^!\.claude\/skills\/$/m.test(gi)) throw new Error(".gitignore is missing `!.claude/skills/`");
	return "new skill files will be tracked";
});

/** Hunk 6 — vendored model catalog: builds must not fetch models.dev/OpenRouter. */
check("hunk6: model catalog is vendored", () => {
	if (!existsSync(join(repoRoot, "packages/ai/src/providers/data"))) {
		throw new Error("packages/ai/src/providers/data missing — run: npm run hydrate:model-data");
	}
	const gitignore = read(".gitignore");
	if (/^packages\/ai\/src\/providers\/data\/?$/m.test(gitignore)) {
		throw new Error(".gitignore still excludes the model catalog — upstream line reintroduced");
	}
	return "data/ tracked";
});

/** Hunk 7 — untrusted project settings must not influence the startup settings manager. */
check("hunk7: startup settings honor persisted trust only", () => {
	const src = read("packages/coding-agent/src/main.ts");
	if (!/new ProjectTrustStore\(agentDir\)\.get\(cwd\) === true/.test(src)) {
		throw new Error("startupProjectTrusted lookup missing — see strape/docs/SECURITY-BACKLOG.md Part 1");
	}
	if (!/SettingsManager\.create\(cwd, agentDir, \{ projectTrusted: startupProjectTrusted \}\)/.test(src)) {
		throw new Error("startup SettingsManager no longer passes projectTrusted — hunk 7 reverted");
	}
	return "project settings gated on trust.json";
});

/** Hunk 8 — a project context file must not be a symlink (it would allow an arbitrary file read). */
check("hunk8: project context files reject symlinks", () => {
	const src = read("packages/coding-agent/src/core/resource-loader.ts");
	if (!/lstatSync\(filePath\)\.isSymbolicLink\(\)/.test(src)) {
		throw new Error("symlink check missing — see strape/docs/SECURITY-BACKLOG.md Part 1");
	}
	if (!/loadContextFileFromDir\(resolvedAgentDir, \{ allowSymlink: true \}\)/.test(src)) {
		throw new Error("agent-dir call lost allowSymlink:true — global ~/.claude/CLAUDE.md link will break");
	}
	if (!/import \{ existsSync, lstatSync,/.test(src)) throw new Error("lstatSync import missing");
	return "project symlinks refused, agent dir allowed";
});

/** Hunk 9 — runtime extension/skill installs must never run npm lifecycle scripts. */
check("hunk9: runtime installs pass --ignore-scripts", () => {
	const src = read("packages/coding-agent/src/core/package-manager.ts");
	// Every install-arg builder must carry the flag: npm, pnpm, bun, and the git-dependency path.
	const builders = [
		/\["install", \.\.\.specs, "--cwd", installRoot, "--omit=peer", "--ignore-scripts"\]/,
		/"--config\.strict-dep-builds=false",\s*"--ignore-scripts",/,
		/\["install", \.\.\.specs, "--prefix", installRoot, "--legacy-peer-deps", "--ignore-scripts"\]/,
		/\["install", "--omit=dev", "--ignore-scripts"\]/,
	];
	const missing = builders.filter((r) => !r.test(src)).length;
	if (missing) throw new Error(`${missing} runtime install path(s) lost --ignore-scripts — see strape/docs/SECURITY-BACKLOG.md Part 1`);
	return "npm/pnpm/bun/git paths all covered";
});

/**
 * Guard: Gemini must stay on the OpenAI-compatible path. If @google/genai ever moves back into
 * dependencies the closure goes 56 -> 93 packages and install-script packages 0 -> 2, so this is asserted
 * separately from hunk 4's list to make the reason explicit at the point of failure.
 */
check("gemini uses the OpenAI-compatible endpoint", () => {
	const compat = read("strape/scripts/claude-compat.mjs");
	if (!/generativelanguage\.googleapis\.com\/v1beta\/openai\//.test(compat)) {
		throw new Error("claude-compat no longer declares Google's OpenAI-compatible endpoint");
	}
	if (!/api: "openai-completions"/.test(compat)) throw new Error("gemini provider is not declared as openai-completions");
	const ai = json("packages/ai/package.json");
	if (ai.dependencies?.["@google/genai"]) {
		throw new Error("@google/genai is back in dependencies — that is 56 -> 93 shipped packages and 2 install scripts");
	}
	return "zero-dependency Gemini";
});

/**
 * Hunk 10 — a vendor fork must never self-update.
 *
 * `getSelfUpdatePlan` asks pi.dev for a version *and* a package name and then installs that server-supplied
 * name globally — the `packageName !== PACKAGE_NAME` branch runs the install *because* it differs. Even the
 * benign path replaces a build pinned to a reviewed tag with upstream's latest npm publish. Both violate
 * CLAUDE.md non-negotiable 3. See strape/docs/SECURITY-BACKLOG.md Part 1.
 */
check("hunk10: self-update refuses on a vendor fork", () => {
	const src = read("packages/coding-agent/src/package-manager-cli.ts");
	if (!/const IS_OFFICIAL_DISTRIBUTION\s*=/.test(src)) {
		throw new Error("IS_OFFICIAL_DISTRIBUTION guard missing — hunk 10 reverted");
	}
	if (!/if \(!IS_OFFICIAL_DISTRIBUTION\) \{/.test(src)) {
		throw new Error("getSelfUpdatePlan no longer short-circuits on a fork");
	}
	// The guard must precede the network call, or the pi.dev request still happens.
	const guardAt = src.indexOf("if (!IS_OFFICIAL_DISTRIBUTION) {");
	const fetchAt = src.indexOf("await getLatestPiRelease(");
	if (guardAt < 0 || fetchAt < 0 || guardAt > fetchAt) {
		throw new Error("the fork guard no longer runs before getLatestPiRelease — pi.dev is still contacted");
	}
	// The triple must match upstream's own isOfficialDistribution (cli/startup-ui.ts), or it silently passes.
	const ui = read("packages/coding-agent/src/cli/startup-ui.ts");
	for (const needle of ['"@earendil-works/pi-coding-agent"', '"pi"', '".pi"']) {
		if (!ui.includes(needle)) throw new Error(`upstream OFFICIAL_* constant changed (${needle} gone) — re-check the guard`);
		if (!src.includes(needle)) throw new Error(`fork guard is missing ${needle} — it would pass on a rebrand`);
	}
	return "strape update --self is refused, before any pi.dev call";
});

/**
 * Hunk 11 — an implicitly trusted project must not escalate itself on reload.
 *
 * A project with nothing trust-requiring in it is trusted with no prompt (`project-trust.ts` returns true
 * when there is nothing to trust). Upstream re-resolves trust only when the caller passes
 * `resolveProjectTrust`, and no `/reload` caller does — so resources that appear mid-session are loaded and
 * executed under the startup decision, and interactive-mode then persists it as a permanent `trusted: true`.
 * See strape/docs/SECURITY-BACKLOG.md Part 1.
 *
 * The escape hatches are asserted too: a guard that revoked trust unconditionally would pass a
 * "does it fail closed?" check while breaking `--approve` and every project the user really did trust.
 */
check("hunk11: implicit project trust is revoked on reload", () => {
	const src = read("packages/coding-agent/src/core/resource-loader.ts");
	if (!/private shouldRevokeImplicitProjectTrust\(\): boolean \{/.test(src)) {
		throw new Error("shouldRevokeImplicitProjectTrust missing — hunk 11 reverted");
	}
	// It must be wired into the branch that runs when the caller passed no trust resolver — that is the
	// /reload path. Present but unreferenced is the failure mode a plain "does the function exist" misses.
	if (!/\} else if \(this\.shouldRevokeImplicitProjectTrust\(\)\) \{/.test(src)) {
		throw new Error("the guard is not wired into reload()'s no-resolver branch — it would never run");
	}
	if (!/this\.settingsManager\.setProjectTrusted\(false\);/.test(src)) {
		throw new Error("the guard no longer drops the project to untrusted");
	}
	// Without the snapshot the guard cannot tell "gained resources" from "always had them", and would fire
	// on every reload of every trusted project.
	if (!/this\.trustRequiringResourcesAtLastLoad = hasTrustRequiringProjectResources\(this\.cwd\);/.test(src)) {
		throw new Error("trustRequiringResourcesAtLastLoad is no longer recorded — the guard loses its baseline");
	}
	for (const [needle, why] of [
		[/if \(this\.projectTrustOverride !== undefined\) return false;/, "--approve/--no-approve would be overridden"],
		[
			/new ProjectTrustStore\(this\.agentDir\)\.get\(this\.cwd\) !== true/,
			"a project the user explicitly trusted would be revoked",
		],
	]) {
		if (!needle.test(src)) throw new Error(`hunk 11 escape hatch missing: ${why}`);
	}
	// The override only reaches the loader if main.ts forwards it.
	const main = read("packages/coding-agent/src/main.ts");
	if (!/projectTrustOverride: parsed\.projectTrustOverride,/.test(main)) {
		throw new Error("main.ts no longer forwards projectTrustOverride — --approve would stop working across reloads");
	}
	// The user has to be able to SEE the revocation. The loader's console.error is a raw write to a screen
	// the TUI owns and gets overdrawn mid-word, and rebuildChatFromMessages() clears the startup banner — so
	// without this call an untrusted project looks trusted after a reload. Measured, not theorised.
	// Anchored INSIDE the reload handler on purpose. Upstream already calls the banner once, from
	// renderInitialMessages() at startup — a looser search finds that call and passes against pristine
	// vendor source, which the negative test against `git show vendor:` caught doing exactly that.
	const tui = read("packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const reloadStart = tui.indexOf("this.keybindings.reload();");
	const reloadEnd = tui.indexOf("const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();");
	if (reloadStart < 0 || reloadEnd < 0 || reloadStart > reloadEnd) {
		throw new Error("cannot locate the /reload handler — re-anchor this invariant before trusting it");
	}
	if (!tui.slice(reloadStart, reloadEnd).includes("this.renderProjectTrustWarningIfNeeded();")) {
		throw new Error("the /reload path no longer re-renders the project-trust banner — a revoked project would look trusted");
	}
	return "reload fails closed, visibly; --approve and persisted trust still honoured";
});

/**
 * Hunk 12 — the agent directory must not be group- or world-accessible.
 *
 * Four writers create `~/<config>` and `~/<config>/agent` with the ambient umask — 0755 at umask 022 and
 * 0775 at umask 002, the default on Debian/Ubuntu and in many container images. User-scope extensions load
 * from there with no trust gate. See strape/docs/SECURITY-BACKLOG.md Part 1.
 */
check("hunk12: agent dir is created and repaired 0700", () => {
	const src = read("packages/coding-agent/src/config.ts");
	if (!/export function ensureAgentDirPermissions\(/.test(src)) {
		throw new Error("ensureAgentDirPermissions missing — hunk 12 reverted");
	}
	if (!/mkdirSync\(dir, \{ recursive: true, mode: 0o700 \}\);/.test(src)) {
		throw new Error("a missing agent dir is no longer created 0700");
	}
	// The repair half. Creation alone leaves every existing install group-readable forever.
	if (!/statSync\(dir\)\.mode & 0o077/.test(src) || !/chmodSync\(dir, 0o700\);/.test(src)) {
		throw new Error("pre-existing directories are no longer repaired — only fresh installs would be private");
	}
	// Hardening the parent is correct for ~/<config> and wrong for a user-chosen ENV_AGENT_DIR, whose parent
	// is an ordinary directory of theirs. Assert the distinction survives.
	if (!/agentDir === defaultAgentDir \? \[dirname\(defaultAgentDir\), defaultAgentDir\] : \[agentDir\]/.test(src)) {
		throw new Error("the default-location check is gone — a custom agent dir's parent would be chmodded too");
	}

	const main = read("packages/coding-agent/src/main.ts");
	const callAt = main.indexOf("ensureAgentDirPermissions(agentDir);");
	if (callAt < 0) throw new Error("main() no longer hardens the agent dir — hunk 12's call site was reverted");
	// Order matters: after the first read or write the directory already exists with the ambient umask.
	const firstUseAt = main.indexOf("SettingsManager.create(cwd, agentDir, { projectTrusted: false })");
	if (firstUseAt < 0 || callAt > firstUseAt) {
		throw new Error("the hardening call no longer precedes the bootstrap SettingsManager");
	}
	return "created 0700, pre-existing dirs repaired, custom locations respected";
});

/**
 * Hunk 13. undici's fetch replays the request body on a 307/308 that crosses origin, so a hijacked provider
 * host could receive the whole conversation. The guard is composed onto the GLOBAL dispatcher rather than set
 * per provider call, because that is the single funnel and a per-call-site flag is what a merge drops quietly.
 * Anchored to the region that composes it, not to the file at large: an assertion that merely finds the word
 * "compose" somewhere would stay green against a build where the guard was detached.
 */
check("hunk13: cross-origin redirects are refused at the dispatcher", () => {
	const src = read("packages/coding-agent/src/core/http-dispatcher.ts");
	if (!/function crossOriginRedirectGuard\(/.test(src)) {
		throw new Error("crossOriginRedirectGuard missing — hunk 13 reverted");
	}
	if (!/CROSS_ORIGIN_REDIRECT_STATUSES = new Set\(\[301, 302, 303, 307, 308\]\)/.test(src)) {
		throw new Error("the redirect status set changed — 307/308 are the body-replaying ones");
	}
	// The guard must be wired into setGlobalDispatcher, not merely defined.
	const setGlobal = src.slice(src.indexOf("undici.setGlobalDispatcher("));
	if (!setGlobal || !/compose\(crossOriginRedirectGuard\(\)\)/.test(setGlobal.slice(0, 400))) {
		throw new Error("the guard is defined but no longer composed onto the global dispatcher");
	}
	// An unparseable Location must be treated as hostile, not followed optimistically.
	if (!/catch \{\s*\/\/[^\n]*\n\s*return true;/.test(src)) {
		throw new Error("an unparseable Location no longer fails closed");
	}
	return "composed onto the global dispatcher, 301-308, fails closed";
});

/**
 * Hunk 14. jiti's fsCache defaults ON and to os.tmpdir()/jiti, where transpiled extension code is written with
 * the ambient umask and later re-executed on a content-hash match. The fix relies on hunk 12 having made the
 * agent dir 0700, so this asserts the path, not a mode.
 */
check("hunk14: jiti's transpile cache is not in /tmp", () => {
	const src = read("packages/coding-agent/src/core/extensions/loader.ts");
	if (!/fsCache: path\.join\(getAgentDir\(\), "cache", "jiti"\)/.test(src)) {
		throw new Error("fsCache is no longer pinned under the agent dir — it defaults to world-writable /tmp");
	}
	if (!/moduleCache: false/.test(src)) {
		throw new Error("moduleCache: false was removed — upstream's own setting, unrelated but load-bearing");
	}
	return "fsCache under <agentDir>/cache/jiti";
});

/**
 * Hunk 15. render() parses model-controlled text and the transformer runs for every rendered message, with no
 * try/catch up the chain — so a parser throw breaks the whole message, not one diagram. Anchored to the render
 * call itself: asserting that the file merely contains "try" would pass against any unrelated try block.
 */
check("hunk15: a mermaid parser throw falls back to source", () => {
	const src = read("packages/coding-agent/src/modes/interactive/components/mermaid.ts");
	const call = src.indexOf("art = render(token.text);");
	if (call < 0) throw new Error("the render() call moved — re-anchor this invariant before trusting it");
	const region = src.slice(Math.max(0, call - 200), call + 200);
	if (!/try\s*\{/.test(region) || !/\}\s*catch\s*\{[\s\S]*?return token\.raw;/.test(region)) {
		throw new Error("render() is no longer wrapped — a parser throw would break message rendering");
	}
	return "render() guarded, falls back to the diagram source";
});

/**
 * Hunk 16. proper-lockfile reclaims a lock on AGE alone (default 10s), not ownership, so a holder that merely
 * stalls loses its lock to a second writer while still believing it holds one. All THREE synchronous call
 * sites must carry the deliberate window — checking one would leave the other two silently on the default,
 * which is how this drifted in the first place (auth-storage's async path had it; its own sync path did not).
 */
check("hunk16: lock stale window is deliberate at every call site", () => {
	const sites = [
		["packages/coding-agent/src/core/trust-manager.ts", "trust.json"],
		["packages/coding-agent/src/core/settings-manager.ts", "settings.json"],
		["packages/coding-agent/src/core/auth-storage.ts", "auth.json"],
	];
	for (const [file, what] of sites) {
		const src = read(file);
		const call = src.indexOf("lockfile.lockSync(");
		if (call < 0) throw new Error(`${file}: lockSync call is gone — re-anchor this invariant`);
		const region = src.slice(call, call + 220);
		if (!/stale:\s*30_000/.test(region)) {
			throw new Error(`${what} takes its lock on the 10s default — a stalled holder can be robbed of it`);
		}
	}
	return "trust.json, settings.json and auth.json all lock with stale: 30_000";
});

/**
 * Guard: Gemini's compat flags. Without them Google's OpenAI-compatibility endpoint rejects pi's
 * reasoning-model request shape (role "developer" + reasoning_effort) with a bare 400 and no body — which is
 * exactly what a user hit. Asserted because it is invisible until someone makes a real API call.
 */
check("gemini provider sets the required compat flags", () => {
	const src = read("strape/scripts/claude-compat.mjs");
	// supportsStore is the one that actually breaks Gemini: pi sends `store: false`, Google rejects unknown
	// fields, and the error surfaces as an unhelpful "400 status code (no body)".
	if (!/supportsStore: false/.test(src)) throw new Error("gemini provider lost supportsStore:false — Gemini will 400");
	if (!/supportsDeveloperRole: false/.test(src)) throw new Error("gemini provider lost supportsDeveloperRole:false");
	if (!/supportsReasoningEffort: false/.test(src)) throw new Error("gemini provider lost supportsReasoningEffort:false");
	return "store + developer role + reasoning_effort disabled";
});

/** Guard: the shipped closure must stay install-script free. */
check("shipped closure has no install scripts", () => {
	const p = "packages/coding-agent/npm-shrinkwrap.json";
	if (!existsSync(join(repoRoot, p))) throw new Error(`${p} missing — run: npm run shrinkwrap:coding-agent`);
	const sw = json(p);
	const withScripts = Object.entries(sw.packages || {})
		.filter(([k, v]) => k.startsWith("node_modules/") && v.hasInstallScript)
		.map(([k]) => k);
	if (withScripts.length) throw new Error(`install scripts present: ${withScripts.join(", ")}`);
	const n = Object.keys(sw.packages || {}).filter((k) => k.startsWith("node_modules/")).length;
	return `${n} packages, 0 install scripts`;
});

/**
 * Guard: upstream adding a NEW provider SDK must fail the check until it is triaged, otherwise a future
 * merge silently re-grows the dependency closure. Upstream's own lazy-load test enumerates the SDKs.
 */
check("no untriaged provider SDK added upstream", () => {
	const testPath = "packages/ai/test/lazy-module-load.test.ts";
	if (!existsSync(join(repoRoot, testPath))) return "lazy-load test absent (upstream removed it) — skipped";
	const src = read(testPath);
	const sdks = new Set([...src.matchAll(/["']((?:@[a-z0-9-]+\/)?[a-z0-9-]+(?:\/[a-z0-9-]+)?)["']/gi)]
		.map((m) => m[1])
		.filter((s) => s.startsWith("@") || s === "openai"));
	const known = new Set([...TRIMMED_SDKS, "openai", "@earendil-works/pi-ai", "@opentelemetry/api"]);
	const untriaged = [...sdks].filter((s) => !known.has(s));
	if (untriaged.length) {
		throw new Error(
			`SDK(s) in the lazy-load test that strape has not triaged: ${untriaged.join(", ")}. ` +
				"Decide whether they are prod deps and update TRIMMED_SDKS / hunk 4.",
		);
	}
	return `${sdks.size} SDKs, all triaged`;
});

/** Guard: the launcher must keep its offline defaults and surface strape's own version identity. */
check("launcher sets offline defaults", () => {
	const src = read("strape/bin/strape");
	for (const needle of ["PI_OFFLINE", "PI_SKIP_VERSION_CHECK"]) {
		if (!src.includes(needle)) throw new Error(`strape/bin/strape does not set ${needle}`);
	}
	return "PI_OFFLINE + PI_SKIP_VERSION_CHECK";
});

/**
 * Guard: strape's version identity lives in strape/VERSION, never in package.json. If someone sets a strape
 * version in a workspace manifest we get a ~17-file merge conflict on every upstream release, and the `^`
 * internal dependency ranges stop resolving. See strape/scripts/version.mjs.
 */
check("version identity is not in package.json", () => {
	const v = read("strape/VERSION").trim();
	if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`strape/VERSION is not plain semver: "${v}"`);
	for (const f of ["packages/coding-agent/package.json", "packages/ai/package.json", "package.json"]) {
		const pkg = json(f);
		if (typeof pkg.version === "string" && /strape/i.test(pkg.version)) {
			throw new Error(`${f} version "${pkg.version}" carries strape branding — keep versions at upstream's`);
		}
	}
	if (!read("strape/bin/strape").includes("strape/VERSION")) {
		throw new Error("launcher no longer surfaces strape/VERSION — users cannot tell two strape builds apart");
	}
	return `strape ${v}, package.json versions untouched`;
});

console.log("strape overlay invariants\n");
for (const p of passes) console.log(`  ok    ${p}`);
for (const f of failures) console.error(`  FAIL  ${f}`);

if (failures.length) {
	console.error(
		`\n${failures.length} invariant(s) broken. A merge from upstream probably reverted a strape hunk.
Re-apply the hunk (see strape/docs/HUNKS.md), do not weaken this check.`,
	);
	process.exit(1);
}
console.log(`\nAll ${passes.length} invariants hold.`);
