# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tonero12/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tonero12/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process — no UI, no
database, no dependencies, and no `git` binary. It serves git smart HTTP
(protocol v0 and v2: clone, fetch, shallow/deepen, push with report-status),
the GitHub REST v3 API (repositories, branches, commits, contents, labels,
issues, comments, pull requests with real squash merges), the GraphQL v4 API
(viewer, repository, issues, pull requests, mutations, introspection), and an
MCP endpoint (create_repo, get_repo, create_issue, list_issues,
create_pull_request, merge_pull_request) — all over one shared in-memory
store, so an object created on any surface is the same object on every other.

The git object store, packfile reader/writer (including delta resolution),
pkt-line codec and three-way merge are implemented from scratch on Node
builtins (`node:http`, `node:crypto`, `node:zlib`).

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at
`MAKEFUN_ENV_URL`, and serves until the env reports the trial is done.
In the grading trial the harness runs `node /bot/main.ts` on Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
