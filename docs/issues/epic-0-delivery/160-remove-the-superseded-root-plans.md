---
title: '[ci] Remove the superseded root planning documents'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

Three documents at the repository root describe a project this is no longer.

`PLAN.md` and `EXECUTION_PLAN.md` describe extracting an AWS architecture designer out of a project
called Archyra into a standalone open-source tool. They give source and target paths under
`/Users/yohansbekele/Archyra` and `/Users/yohansbekele/infracanvas`, neither of which exists. They
record a five-phase plan whose Phase 3 "GitHub Integration" and Phase 4 "GitOps Pipeline" are marked
pending; both shipped long ago. `PLAN.md`'s Key Decisions section states _"GitHub OAuth with PKCE —
secure, no backend required"_, and the repository has had an Express API, a Postgres database and two
server-side authentication methods since `feat(db): move the data layer from MongoDB to Postgres with
pgvector`.

`AGENT_CONTEXT.md` is worse, because it is addressed to the reader this matters most to. It announces
itself as an agent context file, dates itself to a session in March, states _"Current Phase: Phase 2 -
Core Migration"_, and lists as pending work that has since been delivered. An agent that reads root
files before `docs/` — which is the ordinary thing to do — is told the project is a front-end
extraction with no backend.

The delivery system already holds this information, accurately and under review: `docs/DELIVERY.md`
describes the gates and the risk tiers, `docs/issues/README.md` describes the issue contract,
`docs/issues/ROADMAP.md` describes the phases, and the epic directories hold the work itself. Nothing
in the three root files is unique; all of it is either wrong or duplicated.

Deleting rather than archiving under `docs/history/` is deliberate. The content is not a record of a
decision anybody would revisit — it is a stale status report, and git already holds every version of
it for anyone who wants the history. A file under `docs/history/` is a file the next reader still has
to open to discover it does not apply.

`README.md` stays. It is user-facing, largely accurate, and correcting it is a separate concern with a
different audience.

Spec: `docs/issues/README.md`

### Contract

No code contract. The repository root retains `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `LICENSE`
and `AGENT_CONTEXT.md`'s replacement in `docs/`, and no `.md` at the root claims a project phase or a
path outside the repository.

Verified before deletion: no workflow, script, package manifest or document references any of the
three files.

### Files

- `PLAN.md` — DELETE
- `EXECUTION_PLAN.md` — DELETE
- `AGENT_CONTEXT.md` — DELETE

### Acceptance Criteria

- [ ] The three files are removed from the repository.
- [ ] No file in the repository references them by name.
- [ ] `README.md`, `CLAUDE.md`, `CONTRIBUTING.md` and `LICENSE` are untouched.
- [ ] `docs/issues/ROADMAP.md` exists and describes the current phases, so the information the deleted files were reached for has a correct home.

### Required Tests

- No automated test; this is a documentation deletion with no runtime behaviour.
- The reference check is the verification step below and must return nothing: a grep for the three
  filenames across every tracked file finds no inbound link.
- The gates must pass unchanged, which proves nothing built or scanned was reading them.

### Performance Budget

n/a

### Out of Scope

- Rewriting `README.md`. Its project-structure section is behind and its feature list predates the
  repository analysis flow, but it is user-facing and belongs to its own issue.
- Moving any content into `docs/`. Nothing here is worth keeping.
- `docs/DATABASE.md`, which describes intent that is still the intent.

### Dependencies

none

### Verification

```bash
git grep -n -e 'PLAN\.md' -e 'EXECUTION_PLAN' -e 'AGENT_CONTEXT' -- . ':!*.lock'
ls PLAN.md EXECUTION_PLAN.md AGENT_CONTEXT.md 2>&1
pnpm lint && pnpm format:check
```

The grep must print nothing and the `ls` must report three missing files.
