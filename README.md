# pi.dev agent sandbox

Runs the pi.dev coding agent in a resource-limited Docker container, with a
sidecar proxy that holds the real Anthropic/xAI API keys so the agent
container never sees them.

## Layout

- `Dockerfile` — the agent container (pi.dev CLI).
- `docker-compose.yml` — wires up `agent` + `token-proxy`, resource limits,
  and the workspace mount.
- `token-proxy/` — small Node proxy. Holds the real API keys and injects
  them only on requests to `api.anthropic.com` / `api.x.ai`. Everything else
  (general web reads) passes through as a plain forward proxy.
- `pi-config/models.json` — bind-mounted to `/home/agent/.pi/agent/models.json`
  in the agent container. This is what tells pi to send Anthropic/xAI
  requests to `token-proxy` instead of the real provider hosts (see below).
- `workspace/` — bind-mounted into the agent container at `/workspace`. This
  is the only part of your filesystem the agent can see or write to.

## How the secrets isolation works

The `agent` container's environment only contains placeholder strings
(`placeholder-anthropic`, `placeholder-xai`) — never the real keys. The real
keys live only in `token-proxy`'s environment, which is a separate
container the agent has no filesystem or process access to.

Pi reads provider config from `~/.pi/agent/models.json`. Ours
(`pi-config/models.json`) overrides just the `baseUrl` of the built-in
`anthropic` and `xai` providers to point at `token-proxy`, while leaving
their model lists and everything else as built-in defaults — this is a
documented pi feature ("route a built-in provider through a proxy without
redefining models"). Pi still attaches the placeholder key as the
`x-api-key`/`Authorization` header on each request; `token-proxy` strips
that and substitutes the real key before forwarding upstream. So even if
the agent is prompt-injected into trying to exfiltrate its credentials,
there's no real credential in its process for it to send.

Note: pi's credential resolution priority is CLI `--api-key` flag → `auth.json`
→ env var → `models.json` custom-provider keys. Don't run `/login` inside
the container (it would write a real key into `auth.json`, which would then
take priority over the placeholder env var and bypass token-proxy entirely).

As a backstop, `token-proxy` also scans outbound request bodies for the
literal real key strings and blocks the request if found, in case a key
ever ends up in the agent's environment some other way (e.g. read from a
file in the workspace).

This does **not** protect against everything — see Limitations.

## Setup

1. Copy `.env.example` to `.env` and fill in your real keys:

   ```
   cp .env.example .env
   ```

2. Fill in the pi.dev install step in `Dockerfile` (marked `TODO`).

3. Put whatever files/folders the agent needs to work on into `./workspace`.

4. (Recommended) Give pi a system prompt to make it work less independently. Pi
   doesn't ask for confirmation before running commands or editing files the
   way e.g. Claude Code does, so without one it'll act on anything it
   decides to do, no questions asked:

   ```
   cp -R dot-pi-example dot-pi
   ```

   Edit `workspace/.pi/agent/SYSTEM.md` to taste — pi reads it from
   `~/.pi/agent/SYSTEM.md`, which is why it needs to land under
   `workspace/.pi` (bind-mounted to `/home/agent/.pi` in the container).

5. Build and run:

   ```
   docker compose up --build
   ```

## Resource limits (the "don't thrash my machine" protection)

Set in `docker-compose.yml` under `agent`:

- `cpus: "2"`, `mem_limit: 4g` — caps CPU/RAM the agent can consume.
- `pids_limit: 512` — caps process count (blocks fork bombs).
- `read_only: true` root filesystem, with `/tmp` and the cache dir as tmpfs
  — the agent can't write anywhere on disk except `/workspace` and scratch
  space that's wiped on restart.
- `cap_drop: ALL`, `no-new-privileges:true` — strips Linux capabilities the
  agent has no legitimate use for.

Adjust the numbers to taste.

## Adding another paid API's token

Same pattern as Anthropic/xAI — the real token stays in `token-proxy`, the
agent only ever gets a placeholder.

1. Add the real token to `.env`:

   ```
   ACME_API_KEY=...
   ```

2. In `docker-compose.yml`, pass it to `token-proxy` (not `agent`):

   ```yaml
   token-proxy:
     environment:
       - REAL_ACME_API_KEY=${ACME_API_KEY}
   ```

3. In `token-proxy/server.js`, add an entry to the `PROVIDERS` map:

   ```js
   acme: {
     host: "api.acme.com",
     envVar: "REAL_ACME_API_KEY",
     header: "authorization",   // whatever header the API expects
     prefix: "Bearer ",         // "" if the API wants the raw token, no prefix
   },
   ```

4. In `docker-compose.yml`, give the agent a placeholder and point it at the
   new route:

   ```yaml
   agent:
     environment:
       - ACME_API_KEY=placeholder-acme
       - ACME_BASE_URL=http://token-proxy:8080/acme
   ```

   Use whichever env var name the tool/SDK you're calling from inside the
   agent actually reads (check its docs) — `ACME_API_KEY`/`ACME_BASE_URL`
   above are just illustrative names.

That's it — the agent calls `http://token-proxy:8080/acme/...`, the proxy
swaps in the real token and forwards to `api.acme.com`, same as it already
does for Anthropic and xAI.

## Limitations

- **Not a substitute for containment of the agent's own actions.** The
  agent can still read/write/delete anything under `./workspace`, and can
  make arbitrary requests through the proxy to arbitrary web hosts for
  general reads. This setup protects the API keys and your host machine —
  it doesn't stop the agent from making a mess of your workspace or being
  tricked into fetching something malicious.
- **Encoding-based exfil isn't fully blocked.** The body-scan backstop only
  catches the literal real key string. It won't catch, say, the agent
  base64-encoding a secret before sending it, or leaking data by other
  means through an otherwise-allowed request.
- **The `models.json` baseUrl override is confirmed for pi's own LLM calls**
  (Anthropic/xAI), but any *other* paid API/tool the agent shells out to
  needs its own check — whether that tool respects a base-URL env var at
  all is tool-specific. If it doesn't, you'd have to give the agent that
  real key directly (still contained by the resource/filesystem limits,
  just without the key-isolation guarantee for that one credential).
