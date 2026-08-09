/**
 * Bounded retry for pinned-tool downloads.
 *
 * WHY THIS EXISTS
 * `fetch-osv.mjs` and `fetch-tool.mjs` each did a single bare `fetch()`. GitHub release downloads are not
 * reliable enough for that: on 2026-08-12/13 the security workflow failed twice in three consecutive pushes,
 * on two DIFFERENT steps (osv-scanner, then syft), with a success in between — and none of those commits
 * touched the workflow or the fetchers. The failure surfaces as an unhandled `TypeError: fetch failed` with a
 * `SocketError: other side closed`, `bytesWritten: 236, bytesRead: 0`: a raw Node stack that reads like a
 * finding and is really a dropped socket.
 *
 * That matters more here than in an ordinary build. This repo's rule is that a tool failure is not a clean
 * result — GuardDog and socket-scan were both made to fail on lost coverage. The flip side is that a gate
 * which dies on the first flaky socket trains people to hit re-run without reading the output, which is the
 * same habit by a different route.
 *
 * THE ONE HARD RULE
 * Retries cover TRANSPORT ONLY. A sha256 mismatch is never retried and never softened — that is a
 * republished or tampered artifact, and the caller must hard-fail on the first occurrence. Retrying an
 * integrity failure would be retrying until an attacker's copy is accepted. Likewise a 404 fails
 * immediately: that is a wrong version pin, and four attempts at a URL that does not exist only delays the
 * answer.
 *
 * Dependency-free, per CLAUDE.md: a supply-chain tool must not enlarge the supply chain it measures.
 */

/**
 * Fetch a URL, retrying only transport-level failures, and return the body as a Buffer.
 *
 * @param {string} url
 * @param {{attempts?: number, baseDelayMs?: number, log?: (m: string) => void}} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fetchWithRetry(url, opts = {}) {
	const { attempts = 4, baseDelayMs = 1000, log = console.log } = opts;
	let last = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(url, { redirect: "follow" });
			if (res.ok) return Buffer.from(await res.arrayBuffer());

			// 4xx (except 429) is the server telling us the request is wrong, not that it is busy. A 404 here
			// means the pinned version or asset name is incorrect — surface that immediately.
			if (res.status < 500 && res.status !== 429) {
				const err = new Error(`HTTP ${res.status} — not retryable (check the pinned version and asset name)`);
				err.permanent = true;
				throw err;
			}
			last = new Error(`HTTP ${res.status}`);
		} catch (error) {
			if (error?.permanent) throw error;
			// Network-layer failure: ECONNRESET, UND_ERR_SOCKET, DNS, TLS. Retryable.
			const cause = error?.cause?.code ? `${error.message} (${error.cause.code})` : error?.message;
			last = new Error(cause ?? String(error));
		}

		if (attempt < attempts) {
			const delay = baseDelayMs * 2 ** (attempt - 1);
			log(`  attempt ${attempt}/${attempts} failed: ${last.message} — retrying in ${delay}ms`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	const err = new Error(`all ${attempts} attempts failed; last error: ${last?.message}`);
	err.exhausted = true;
	throw err;
}
