#!/usr/bin/env node
/**
 * Regression test for hunk 13: the global dispatcher must refuse cross-origin redirects.
 *
 * WHAT WAS WRONG
 * undici's fetch() strips Authorization/Cookie/Proxy-Authorization when a redirect crosses origin
 * (lib/web/fetch/index.js:1350-1358) but, per spec, keeps every other header and REPLAYS THE BODY on 307/308.
 * strape's provider calls use the global fetch that undici.install() replaces, so a compromised or
 * DNS-hijacked provider host answering 307 would POST the whole conversation to an attacker origin. The
 * dependency review's adversarial pass proved the path is live, not hypothetical (dep-review-v0.84.0.md §1).
 *
 * WHY IT IS TESTED WITH REAL SOCKETS
 * The control lives in an undici interceptor, and undici's handler protocol is version-specific — a unit test
 * against a mocked handler would pass against an interceptor that never actually runs. These assertions drive
 * two real HTTP servers through the real installed global fetch, and the exfiltration assertion checks what the
 * ATTACKER SERVER RECEIVED, not merely that fetch rejected: a guard that errors after replaying the body would
 * still be a breach, and only the receiving end can prove it did not happen.
 *
 * Stand-aside cases are pinned too. A guard that blocks every redirect would pass a naive "does it fail
 * closed?" test while breaking ordinary /v1 -> /v1/ behaviour.
 *
 * Requires a build (npm run build:offline). Binds only to 127.0.0.1; no external network.
 */

import { createServer } from "node:http";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distDispatcher = join(repoRoot, "packages/coding-agent/dist/core/http-dispatcher.js");

let configureHttpDispatcher;
try {
	({ configureHttpDispatcher } = await import(`file://${distDispatcher}`));
} catch (e) {
	console.error(`Cannot import ${distDispatcher}: ${e.message}\nBuild first: npm run build:offline`);
	process.exit(1);
}

const results = [];
const check = (name, ok, detail) => results.push({ ok, name, detail });

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

// The "attacker" origin. Records every request body it is handed.
const received = [];
const sink = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		received.push({ url: req.url, method: req.method, body });
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("sink");
	});
});
const sinkPort = await listen(sink);

// The "provider" origin.
const provider = createServer((req, res) => {
	if (req.url === "/cross") {
		res.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/steal` });
		res.end();
		return;
	}
	if (req.url === "/same") {
		res.writeHead(307, { location: "/landing" });
		res.end();
		return;
	}
	if (req.url === "/landing") {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(`landed:${body}`);
		});
		return;
	}
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("ok");
});
const providerPort = await listen(provider);
const origin = `http://127.0.0.1:${providerPort}`;

try {
	configureHttpDispatcher();

	// 1. The control: a cross-origin 307 must fail, and the body must never reach the other origin.
	const secret = "CONVERSATION-SECRET-THAT-MUST-NOT-LEAK";
	let crossError = null;
	try {
		await fetch(`${origin}/cross`, { method: "POST", body: secret });
	} catch (e) {
		crossError = e;
	}
	check("a cross-origin 307 fails the request", crossError !== null, crossError ? "rejected" : "FETCH RESOLVED — the redirect was followed");
	check(
		"...and the attacker origin received nothing at all",
		received.length === 0,
		received.length === 0 ? "sink saw 0 requests" : `LEAKED: sink saw ${received.length} request(s)`,
	);
	check(
		"...and the body was never replayed",
		!received.some((r) => r.body.includes(secret)),
		received.some((r) => r.body.includes(secret)) ? "SECRET PRESENT IN SINK BODY" : "secret absent from sink",
	);
	const message = String(crossError?.cause?.message ?? crossError?.message ?? "");
	check("...with an explanatory error, not a bare socket failure", /cross-origin redirect/.test(message), message.slice(0, 90) || "(empty)");

	// 2. Stand-aside: a same-origin redirect must still be followed, body intact.
	let sameOk = null;
	let sameErr = null;
	try {
		const res = await fetch(`${origin}/same`, { method: "POST", body: "payload" });
		sameOk = await res.text();
	} catch (e) {
		sameErr = e;
	}
	check(
		"a same-origin 307 is still followed",
		sameOk === "landed:payload",
		sameErr ? `threw: ${String(sameErr.message).slice(0, 60)}` : `got ${JSON.stringify(sameOk)}`,
	);

	// 3. Stand-aside: ordinary non-redirect traffic is untouched.
	const plain = await fetch(`${origin}/plain`).then((r) => r.text());
	check("ordinary responses pass through", plain === "ok", `got ${JSON.stringify(plain)}`);
} finally {
	await close(provider);
	await close(sink);
}

console.log("strape cross-origin redirect guard (hunk 13)\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: the cross-origin redirect guard is not holding.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
