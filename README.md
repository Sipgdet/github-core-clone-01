# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sipgdet/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sipgdet/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


A standalone forge that serves all four of GitHub's agent-facing surfaces from
one Node 22 process and its own in-memory store, with no UI and no outside
service: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API,
GraphQL v4, and MCP over Streamable HTTP.

## Run

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. Nothing is installed: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

The env at `MAKEFUN_ENV_URL` is the service the forge answers: it binds an
ephemeral port, registers it, and exits 0 when the env says the trial is done
(see `main.ts`).

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server and routing for the four surfaces.
- `git.ts` — pkt-lines, packfiles (plain, no deltas), upload-pack v2/v0,
  ls-refs, fetch planning (including shallow/deepen) and receive-pack.
- `store.ts` — the in-memory store: git objects, refs, repos, issues, pulls.
- `rest.ts` — the REST v3 API: repos, branches, commits, contents, labels,
  issues, comments, pull requests and squash merges.
- `graphql.ts` — GraphQL v4 for the documents `gh` and `github-mcp-server`
  send, including introspection, cursor pagination and batched operations.
- `mcp.ts` — MCP (revision 2026-07-28 via `server/discover`, plus the legacy
  `initialize` handshake) with six tools over the same store.
- `scenario.ts` — the trial's fixed identities, recomputed from the kit's
  published deterministic scenario seed (the bearer token carries no login).

## Notes

- Deterministic: server-built commits and timestamps use a fixed epoch and a
  monotonic sequence, never the wall clock, so two runs on the same instance
  export the same state byte for byte.
- The bearer token is `MAKEFUN_SHOP_TOKEN`; a request without it is 401, and a
  repository belongs to the login the token names.
- Every reply carries `X-GitHub-Request-Id`; every error body is JSON with a
  string `message`.

## Local grade (practice trial 0, from the kit)

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```

Practice result: **120/120 conformance checks, score 927** (feature 600,
agent 200, perf 127), replay byte-identical.

<sub>Entered on [make.fun](https://make.fun/?ref=hg93qv6n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
