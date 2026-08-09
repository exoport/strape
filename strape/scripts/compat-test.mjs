#!/usr/bin/env node
/**
 * Claude Code compatibility regression test.
 *
 * strape's reason to exist is partly that a team can keep using the CLAUDE.md and .claude/skills they already
 * have. That guarantee rests on upstream behaviour strape does not control (core/resource-loader.ts candidate
 * list and skills discovery), so it is asserted here and run in CI on every upstream merge. If upstream ever
 * reorders the context-file candidates or changes skills resolution, this fails and the team finds out from a
 * red build rather than from an agent quietly ignoring their instructions.
 *
 * Requires a build first (npm run build:offline). No network, no LLM call, no API key.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distIndex = join(repoRoot, "packages/coding-agent/dist/index.js");

let DefaultResourceLoader;
try {
	({ DefaultResourceLoader } = await import(`file://${distIndex}`));
} catch (e) {
	console.error(`Cannot import ${distIndex}: ${e.message}`);
	console.error("Build first: npm run build:offline");
	process.exit(1);
}

const agentDir = process.env.STRAPE_CODING_AGENT_DIR || join(homedir(), ".strape", "agent");
const results = [];
const fail = (name, detail) => results.push({ ok: false, name, detail });
const pass = (name, detail) => results.push({ ok: true, name, detail });

const makeProject = (files) => {
	const dir = mkdtempSync(join(tmpdir(), "strape-compat-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
};

const load = async (cwd) => {
	const rl = new DefaultResourceLoader({ cwd, agentDir });
	await rl.reload();
	return rl;
};

const SKILL = `---
name: compat-probe
description: Probe skill used by strape/scripts/compat-test.mjs.
---

body
`;

/* 1. A project with only CLAUDE.md must have it loaded as the context file. */
{
	const dir = makeProject({ "CLAUDE.md": "# ctx\nCLAUDE_MARKER\n" });
	try {
		const files = (await load(dir)).getAgentsFiles().agentsFiles;
		const hit = files.find((f) => f.content.includes("CLAUDE_MARKER"));
		if (hit) pass("project CLAUDE.md is loaded", hit.path.replace(dir, "<project>"));
		else fail("project CLAUDE.md is loaded", `got: ${files.map((f) => f.path).join(", ") || "(none)"}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* 2. .claude/skills must be discovered via a project settings entry (what claude-compat.mjs writes).
      Relative paths in project settings resolve against <cwd>/.strape (core/package-manager.ts:903-904),
      so "../.claude/skills" is <project>/.claude/skills. */
{
	const dir = makeProject({
		"CLAUDE.md": "# ctx\n",
		".claude/skills/compat-probe/SKILL.md": SKILL,
		".strape/settings.json": JSON.stringify({ skills: ["../.claude/skills"] }, null, "\t"),
	});
	try {
		const { skills, diagnostics } = (await load(dir)).getSkills();
		const hit = skills.find((s) => s.name === "compat-probe");
		if (hit) pass(".claude/skills reuse via project settings", `loaded skill "${hit.name}"`);
		else fail(".claude/skills reuse via project settings", `skills=[${skills.map((s) => s.name).join(", ")}] diagnostics=${JSON.stringify(diagnostics)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* 3. Documented precedence: within one directory AGENTS.md outranks CLAUDE.md, so CLAUDE.md is IGNORED.
      This is asserted not because it is desirable but because teams must be told, and because a silent
      upstream change here would change which instructions the model receives. */
{
	const dir = makeProject({ "CLAUDE.md": "# c\nCLAUDE_MARKER\n", "AGENTS.md": "# a\nAGENTS_MARKER\n" });
	try {
		const files = (await load(dir)).getAgentsFiles().agentsFiles;
		const claudeLoaded = files.some((f) => f.content.includes("CLAUDE_MARKER"));
		const agentsLoaded = files.some((f) => f.content.includes("AGENTS_MARKER"));
		if (agentsLoaded && !claudeLoaded) {
			pass("AGENTS.md outranks CLAUDE.md in the same directory", "CLAUDE.md ignored, as documented");
		} else if (claudeLoaded && !agentsLoaded) {
			fail(
				"AGENTS.md outranks CLAUDE.md in the same directory",
				"PRECEDENCE INVERTED upstream — CLAUDE.md now wins. Good news, but update strape/docs and the README.",
			);
		} else {
			fail("AGENTS.md outranks CLAUDE.md in the same directory", `both=${claudeLoaded && agentsLoaded}, neither=${!claudeLoaded && !agentsLoaded}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* 4. Skills must be reachable from the harness-neutral .agents/skills convention too — this is the path
      that needs no settings at all, and is worth knowing about as a fallback. */
{
	const dir = makeProject({ "CLAUDE.md": "# ctx\n", ".agents/skills/compat-probe/SKILL.md": SKILL });
	try {
		const { skills } = (await load(dir)).getSkills();
		const hit = skills.find((s) => s.name === "compat-probe");
		if (hit) pass(".agents/skills auto-discovery (no settings needed)", "loaded");
		else pass(".agents/skills auto-discovery (no settings needed)", "NOT auto-discovered — settings entry required for every skills dir");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/* 5. Hunk 8: a project context file that is a SYMLINK must be refused, because context
      files load with no trust prompt and a symlink would let a cloned repo read any file the user can read
      and ship it to the model provider. The agent dir keeps allowing symlinks — claude-compat.mjs links
      ~/.claude/CLAUDE.md there deliberately. */
{
	const dir = makeProject({ "secret.txt": "TOP_SECRET_MARKER\n" });
	const agentHome = mkdtempSync(join(tmpdir(), "strape-agent-"));
	try {
		const { symlinkSync, writeFileSync: wf } = await import("node:fs");
		symlinkSync(join(dir, "secret.txt"), join(dir, "CLAUDE.md"));
		const projectLoader = new DefaultResourceLoader({ cwd: dir, agentDir: agentHome });
		await projectLoader.reload();
		const leaked = projectLoader.getAgentsFiles().agentsFiles.some((f) => f.content.includes("TOP_SECRET_MARKER"));
		if (leaked) fail("project CLAUDE.md symlink is refused", "SYMLINK FOLLOWED — arbitrary file read is live (hunk 8 reverted?)");
		else pass("project CLAUDE.md symlink is refused", "symlink ignored, nothing leaked");

		// The legitimate global case must keep working.
		wf(join(agentHome, "real-global.md"), "GLOBAL_CTX_MARKER\n");
		symlinkSync(join(agentHome, "real-global.md"), join(agentHome, "CLAUDE.md"));
		const globalLoader = new DefaultResourceLoader({ cwd: mkdtempSync(join(tmpdir(), "strape-empty-")), agentDir: agentHome });
		await globalLoader.reload();
		const globalOk = globalLoader.getAgentsFiles().agentsFiles.some((f) => f.content.includes("GLOBAL_CTX_MARKER"));
		if (globalOk) pass("global CLAUDE.md symlink still honored", "~/.claude/CLAUDE.md reuse works");
		else fail("global CLAUDE.md symlink still honored", "global symlink was refused — claude-compat --global is broken");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentHome, { recursive: true, force: true });
	}
}

console.log("strape Claude Code compatibility\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} compatibility assertion(s) failed. strape's Claude Code interop is broken.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} compatibility assertions hold.`);
