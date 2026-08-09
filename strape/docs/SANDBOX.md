# Testing strape in a sandbox

strape inherits pi's design: the built-in tools run shell commands and read/write files with the privileges
of the process, and prompt injection from repository content is unmitigated. For trying it out — especially
against a repository you did not write — run it contained.

`strape/sandbox/strape-sandbox` is the lightweight option: [bubblewrap](https://github.com/containers/bubblewrap),
which is a user namespace, not a container runtime. No daemon, no image build, no root, ~50ms startup.
Upstream documents heavier patterns (Gondolin micro-VM, Docker, OpenShell) in
`packages/coding-agent/docs/containerization.md`; use one of those if you need a network boundary too.

## What it actually contains — verified, not asserted

| Property | Verified behaviour |
|---|---|
| Real home hidden | `ls /home` returns **empty**; `~/.ssh`, `~/.aws`, `~/.claude`, your real `~/.strape` and every other repo are not reachable |
| Filesystem read-only | `touch /etc/probe` and `touch /usr/probe` both fail with `Read-only file system` |
| strape itself read-only | the agent cannot rewrite its own gates — writing to `verify-overlay.mjs` fails |
| Writable surface | exactly three: the sandbox home, the workspace you name, and a private `/tmp` |
| Credentials contained | `auth.json` is written to the sandbox agent dir, so a test login cannot land in your real one |
| Temp spill contained | `/tmp` is a private tmpfs, so the bash-overflow and `/share` files described in the backlog never touch the host |

**What it does not contain: the network.** That is deliberate and it is the honest caveat — the LLM APIs need
it, and OpenAI's OAuth callback binds `localhost:1455`, which only works if the sandbox and your browser share
a namespace. So this is a **filesystem and privilege boundary, not an exfiltration boundary**. An agent that
decides to POST your workspace somewhere still can. If that matters, use a VM.

## Setup

```sh
sudo apt install bubblewrap                 # if missing
npm ci --ignore-scripts && npm run build:offline
strape/sandbox/strape-sandbox --init
```

`--init` seeds the sandbox agent dir with settings and the `gemini-openai` provider (via `claude-compat`), and
installs the pinned, sha256-verified `rg`/`fd`. It needs network once, for those binaries.

## Credentials

Log in **inside** the sandbox, so tokens are written to the sandbox agent dir and thrown away with `--reset`.

`/login` is a slash command **inside a running strape session**, not a shell command and not a CLI
subcommand. There are three prompts involved and it matters which one you are at:

```
$ strape/sandbox/strape-sandbox          # 1. your host shell -> opens a shell INSIDE the sandbox
[strape-sandbox] /mnt/workspace $ strape # 2. sandbox shell   -> starts a strape session
> /login xai                             # 3. strape prompt   -> the actual login
```

Or skip the middle step and launch a session directly:

```sh
strape/sandbox/strape-sandbox --         # starts strape immediately inside the sandbox
```

Then, at strape's own prompt:

```
/login xai        # device code: prints a URL + code you approve in a browser
/login openai     # opens a browser to a callback on localhost:1455
/logout           # remove a stored credential
```

(`strape auth` is a different command entirely — it *prints* an already-configured credential to stdout. It
will not log you in, and it is the exfiltration primitive noted in the backlog.)

| Provider | How | Works in the sandbox? |
|---|---|---|
| **xAI (Grok)** | device-code flow — prints a URL and a code, you approve in your browser | **yes**, nothing to forward |
| **OpenAI (ChatGPT Plus/Pro)** | opens a browser to a callback on `localhost:1455` | **yes**, because the network namespace is shared. Override the bind host with `PI_OAUTH_CALLBACK_HOST` if needed |
| **Gemini** | API key only — no OAuth exists for Google in pi | export `GEMINI_API_KEY` before launching; the script passes it through |

`OPENAI_API_KEY` and `XAI_API_KEY` are also passed through if set, for key-based auth instead of OAuth.

**If Gemini returns `400 status code (no body)`:** that message is an unhelpful disguise. Google's
OpenAI-compatibility layer validates strictly and rejects any field it does not recognise, and pi sends
`store: false` (an OpenAI-only field, `api/openai-completions.ts:711-713`). Google replies

```
400 Invalid JSON payload received. Unknown name "store": Cannot find field.
```

but wraps it in a JSON **array**, which the `openai` SDK cannot parse — hence "no body". The fix is
`compat: { supportsStore: false }` on the provider, which `claude-compat` now writes and also adds to an
existing entry in place, so `--init` repairs an older config.

Verified end-to-end: a real call through strape returns normally with that flag set. Removing `store` alone was
enough — the full request including all four tool definitions is otherwise accepted.

**Any other provider error — run the probe first.** It talks to the provider with no SDK in the way, unwraps
Google's array-shaped error body, and prints the message the TUI swallows:

```sh
node strape/scripts/provider-probe.mjs gemini-openai --models
```

It reports, per declared model: whether the key resolved (without printing it), whether the key can see the
model, and the real status and message. Known outcomes it names for you:

| What you see | What it means |
|---|---|
| `Unknown name "…"` | strict field validation — set the matching `compat` flag |
| `Please pass a valid API key` at status **400** | an auth failure wearing a 400, not a request problem |
| **404** | that key/project cannot see the model — check the `--models` list |
| **429** with `limit: 0` | the model is not offered on your tier *at all*; this is not a rate limit |

**Model availability differs per key, which is the trap.** Measured against two real keys:

| Model | Older key | New key |
|---|---|---|
| `gemini-2.5-flash` | 200 | **404 — "no longer available to new users"** |
| `gemini-2.5-pro` | 429 `limit: 0` | 429 `limit: 0` (not offered on the free tier at all) |
| `gemini-flash-lite-latest` | — | **200** |

Google closes *pinned* model versions to new projects while existing keys stay grandfathered, so a pinned
config works for one person and 404s for their colleague. That is why the shipped config declares the
**`-latest` alias ids**, and why `claude-compat --global` rewrites pinned ids (and a stale `defaultModel`) in
place when you re-run it.

Get a key at **https://aistudio.google.com/apikey**.

If the probe passes but strape still fails, the difference is in pi's request body. Point `baseUrl` at a local
mock, capture the exact body, and replay it with `curl` — that is how the `store` field was found.

Use a **separate, revocable** Gemini key for testing rather than a production one. The sandbox stops the agent
reading your other credentials; it does not stop it misusing the one you hand it.

## Running

```sh
strape/sandbox/strape-sandbox                          # interactive shell; `strape` is on PATH inside
strape/sandbox/strape-sandbox -- --list-models         # run strape directly
strape/sandbox/strape-sandbox --workspace ~/code/thing # bind a real project (writable!)
strape/sandbox/strape-sandbox --reset                  # delete the sandbox home and its credentials
```

Inside: `HOME` is `/mnt/home`, the workspace is `/mnt/workspace` and is the working directory, strape is
read-only at `/mnt/strape`.

Note `--workspace` binds that directory **writable** — the agent can modify it, which is usually the point.
Point it at a scratch clone, not your only copy.

## Why `/mnt`

The whole filesystem is bound read-only, so new mount points cannot be created at `/`. `/mnt` is made a tmpfs
and used as the mount root. `/home` and `/root` are also tmpfs — that is the mechanism that hides the real
home rather than merely not referencing it.

One host-specific detail handled in the script: Volta's `node` is a shim that resolves its toolchain from
`$HOME`, which the sandbox replaces, so the script binds the **real** interpreter directory instead of
whatever is first on `PATH`.

## What this is good for, and what it is not

Good for: trying strape against an unfamiliar repository, testing the review workflow, letting the agent run
shell commands without risking your dotfiles, throwing away credentials afterwards.

Not a substitute for the open items in `strape/docs/SECURITY-BACKLOG.md` Part 2. The sandbox limits blast
radius; it does not fix the HTML-export escaping or the world-readable transcript files. It also does not stop
network exfiltration, as above.

It is, however, the right place to *exercise* the two hunks that closed the former P1 and P2 — the trust
escalation on `/reload` (hunk 11) and the group-writable agent directory (hunk 12). Both have regression
tests, but both are ultimately about live behaviour:

```sh
# hunk 12 — the repair half, which only shows up on a dir that already exists with loose bits.
# --init's mkdir runs on the HOST with your host umask, so this really does create 0775.
strape/sandbox/strape-sandbox --reset
( umask 002 && strape/sandbox/strape-sandbox --init )
stat -c '%a %n' ~/.strape-sandbox/home/.strape ~/.strape-sandbox/home/.strape/agent   # expect 775 775
strape/sandbox/strape-sandbox -- --version                                            # one run is enough
stat -c '%a %n' ~/.strape-sandbox/home/.strape ~/.strape-sandbox/home/.strape/agent   # expect 700 700
```

Both levels are hardened here because the sandbox sets `STRAPE_CODING_AGENT_DIR` to the same path
`getAgentDir()` would have derived from `HOME`, so it takes the default-location branch.

```sh
# hunk 11 — a project trusted when it had nothing to trust must not escalate itself on /reload.
rm -rf ~/.strape-sandbox/workspace/.strape        # must start with NOTHING trust-requiring
strape/sandbox/strape-sandbox --                  # session starts; no trust prompt, correctly

# …then from your HOST shell, while that session is still open:
mkdir -p ~/.strape-sandbox/workspace/.strape/skills/probe
printf -- '---\nname: probe\ndescription: should not load\n---\nprobe\n' \
  > ~/.strape-sandbox/workspace/.strape/skills/probe/SKILL.md
```

Back in the session, run `/reload`. The skill must **not** appear in the reloaded-resources list, and the
untrusted banner should appear.

Then the two stand-aside cases, which are the ones a wrong fix breaks quietly:

```sh
# 1. persisted decision — /trust → "Trust" (NOT "this session only", which persists nothing), then restart.
#    Expect: no prompt, no banner, the skill loads, and a further /reload keeps it.

# 2. --approve. BOTH preconditions must be reset or this proves nothing:
rm -f  ~/.strape-sandbox/home/.strape/agent/trust.json   # else it stands aside for the PERSISTED reason
rm -rf ~/.strape-sandbox/workspace/.strape               # else nothing escalates and nothing is armed
strape/sandbox/strape-sandbox -- --approve
#    …re-create the skill from the host, /reload. Expect: skill loads, no banner.
#    Then confirm trust.json still does not exist — a one-run flag must not become permanent.
```

The trust store keys on the **in-sandbox** path (`/mnt/workspace`), so binding a different host directory
with `--workspace` does *not* give a fresh trust identity. Clear `trust.json` instead.

All three states were verified this way on 2026-08-08; the results are in
`strape/audit/review-v0.84.0.md` §10a.

**If `--init` printed `note: rg/fd provisioning failed`,** or a session says `fd not found`, the pinned
hash-verified binaries were never installed and `grep`/`find` are silently falling back to whatever the host
has — i.e. the control the launcher's `PI_OFFLINE=1` exists to make room for did not apply. The note goes to
stderr during `--init` and is easy to scroll past; check for `~/.strape-sandbox/home/.strape/agent/bin` and
re-run `--init` (idempotent, and unlike `--reset` it keeps your credentials).
