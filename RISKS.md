# Known risks and limitations

This setup contains the agent well enough for casual/local use, but it is
not a hard security boundary. Read this before trusting it with anything
sensitive.

## API key / secret exfiltration

- The agent container never holds real Anthropic/xAI keys — see `README.md`
  for how `token-proxy` + `pi-config/models.json` isolate those.
- **Encoding-based exfil isn't blocked.** `token-proxy`'s body-scan backstop
  only catches the literal real key string in plaintext bodies. It doesn't
  catch a key that's been base64-encoded, split up, or otherwise obfuscated
  before being sent — though since the agent never actually has the real
  key, this mostly matters only if a key leaks into the agent by some other
  route (e.g. it's accidentally committed into a file under `./workspace`).
- **HTTPS traffic is invisible to the backstop entirely.** Almost all real
  traffic goes through `token-proxy`'s `CONNECT` tunnel handler, which is an
  opaque encrypted passthrough — the proxy cannot inspect anything inside a
  TLS session, so the body-scan only ever applies to the small number of
  plain-HTTP requests.
- Any *other* paid API token you add (see README) is only proxy-isolated if
  the tool/SDK calling it actually respects a base-URL override. That's
  unverified per-tool — if it doesn't, you're handing the agent the real
  key directly.
- Don't run `/login` inside the agent container — it writes a real key into
  `auth.json`, which outranks the placeholder env var in pi's credential
  resolution order and bypasses `token-proxy` entirely.

## Network egress

- **There is currently no domain allowlist.** The agent can reach any host
  on the internet through `token-proxy` — GitHub, npm, or an
  attacker-controlled domain if it's tricked into contacting one (e.g. via
  prompt injection from fetched content, or a malicious dependency).
- This means the agent can also be used as a path for command-and-control
  callbacks, or to download and run arbitrary code (see below).

## Malware / arbitrary code execution

- The agent can `curl | bash`, `npm install`, `pip install`, etc. — nothing
  stops it from downloading and executing arbitrary code inside the
  container.
- `read_only: true` root filesystem means most of that doesn't persist
  between runs (a fresh container has no memory of what a previous one
  installed to system paths).
- `cap_drop: ALL` + `no-new-privileges` raise the bar on privilege
  escalation / container escape attempts, but do not eliminate the risk
  category.
- CPU/memory limits (`cpus`, `mem_limit`) cap how much damage a
  cryptominer/runaway process can do to your host, but the agent's
  allotted share can still be fully consumed.

## Workspace persistence and symlink risk

- `./workspace` is a bind mount, so **anything the agent writes there
  persists on your real host filesystem** after the container exits. This
  is the main channel by which "the agent ran something bad" turns into
  "something bad is now on my machine."
- The agent **cannot** use symlinks to escape the container and read/write
  arbitrary host files. Docker's mount namespace is a kernel-level
  boundary, not a path check — a symlink created inside the container to
  e.g. `/etc/passwd` or an absolute Windows path resolves inside the
  container's own filesystem, not the host's. There is no path syntax that
  reaches outside the container's given mounts.
- **The real risk runs the other direction:** the agent can plant a symlink
  *inside* `./workspace` whose target is a real host path (e.g.
  `C:\Users\wongw\.ssh\id_rsa`). That symlink is meaningless while the
  container is running, but once the container exits, it's just a symlink
  sitting in your real `workspace` folder. If you (or an editor, backup
  tool, antivirus scanner, etc.) later open or process that file on the
  host and blindly follow the symlink, you — outside the container — end up
  reading or exposing whatever it points to.
  - Mitigation: before trusting/opening anything under `./workspace`,
    check for symlinks whose target resolves outside `./workspace`. Not yet
    automated here — worth adding a pre-check script if this setup is used
    for anything beyond casual local use.

## General

- None of this defends against a determined, sophisticated attacker who
  specifically targets this setup. It raises the bar against the realistic
  failure mode (an agent misled by prompt injection or a malicious
  dependency doing something dumb), not against targeted intrusion.
- Resource limits, filesystem read-only-ness, and network isolation are all
  configured in `docker-compose.yml` and easy to tighten further — see
  `README.md` for what's there today.
