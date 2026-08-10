# Issue specifications

Agent-ready issues are written as files here and pushed to GitHub, rather than typed into the issue
form.

The premise of the delivery system is that an agent picking up an issue reads only that issue and
the spec it links. The issue text _is_ the engineering contract, and a contract belongs under version
control with everything else it governs: it can be reviewed in a pull request before anyone starts
work, its history explains why a requirement changed, and the whole backlog can be recreated if the
repository ever is.

## Layout

```
docs/issues/
  epic-1-data/
    010-postgres-core-identity.md
    020-delete-duplicated-vercel-api.md
```

The numeric prefix is ordering, not priority; it keeps a directory listing in roughly the order the
work lands. Real ordering lives in each issue's `Dependencies` section, which GitHub renders as a
graph.

One directory per epic, matching the `epic:` labels:

| Directory           | Epic                                   |
| ------------------- | -------------------------------------- |
| `epic-0-delivery`   | Gates and developer tooling            |
| `epic-1-data`       | Postgres foundation and the job queue  |
| `epic-2-ir`         | Architecture IR and resource contracts |
| `epic-3-engine`     | Rust ingestion engine                  |
| `epic-4-retrieval`  | Hybrid retrieval and evaluation        |
| `epic-5-graphrag`   | Code graph and community summaries     |
| `epic-6-brain`      | Agent runtime and provider layer       |
| `epic-7-prediction` | Cost, latency, scale, and availability |
| `epic-8-codegen`    | Pulumi generation and validation       |
| `epic-9-deploy`     | AWS connection, deployment, guardrails |
| `epic-10-loadtest`  | Load testing and measured SLIs         |
| `epic-11-web`       | Canvas and dashboards                  |
| `epic-12-launch`    | Merge-back, self-hosting, and security |

## File format

A `---` header followed by the issue body:

```markdown
---
title: '[db] Repository and ingestion run tables'
labels: tier:2, size:s, area:db, epic:1-data
---

### Epic

#2

### Context

...
```

The body uses the same `### Heading` sections that `.github/ISSUE_TEMPLATE/agent-task.yml`
produces, because Gate 0 parses both the same way. Every section in that template is required.

## Creating and updating

```bash
pnpm gh:issues --dry-run       # show what would change
pnpm gh:issues                 # create or update on GitHub
pnpm gh:issues --epic 1        # limit to one epic
```

Matching is by title, so running it twice updates rather than duplicating. Changing a title creates
a second issue; edit the title on GitHub too, or close the original.

Before touching GitHub the seeder runs Gate 0's own validation against each file. Creating an issue
only to have the gate immediately label it `needs-spec` wastes a round trip and leaves a rejection
comment on an issue nobody has read yet.

## Writing a spec worth following

The sections that are usually done badly:

**Contract** is copy-pasteable signatures, DDL, or types. If you cannot write it, the issue is not
ready and something it depends on has to land first. An agent that has to invent an interface will
invent a different one than the next agent does.

**Acceptance Criteria** are observable behaviours, one per line. "Handles errors correctly" is not
checkable; "returns null rather than throwing when the ciphertext cannot be decrypted" is.

**Required Tests** are named cases, including the failure and edge cases. An agent writes exactly
the tests listed, so anything omitted here becomes a coverage gap nobody notices.

**Out of Scope** is the main defence against drift. Be specific about the adjacent code that will
look tempting to clean up along the way.
