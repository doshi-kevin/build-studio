# Scholera codebase guide

Seven documents that take you from "what is this repository" to "I can ship a change."

Scholera is a learning management system with AI built in rather than added on. Next.js 16 and
Supabase, multi-tenant (an institution holds professors, students, staff, and admins), with Gemini
used for course authoring, tutoring, grading, and analytics. It runs on Google Cloud Run. The repo
is around 2,200 tracked files and 240-odd database migrations, so nobody reads it all. These
guides tell you which part to read.

## The guides

| Guide | What you get | Read it when |
|---|---|---|
| [1-overview.md](./1-overview.md) | What this is, why it exists, where to start. About 5 minutes. | First. |
| [2-quick-start.md](./2-quick-start.md) | Getting it running locally with seeded data, plus what to do when that fails. | You are setting up your machine. |
| [3-concepts.md](./3-concepts.md) | The vocabulary: tenancy, sections, Athena, Live Classroom, mastery, feature toggles. | A word keeps coming up and you do not know what it means. |
| [4-visual-tree.md](./4-visual-tree.md) | The complete file map, plus a shorter annotated tree of the landmarks. | You are trying to find where something lives. |
| [5-architecture.md](./5-architecture.md) | How the system is built and why: layers, data flow, the security model, deployment, known debt. | Before your first change that touches more than one file. |
| [6-file-insights.md](./6-file-insights.md) | The files everything else depends on (data layer, auth gates, AI plumbing), and what order to read them in. | Before you touch the core. |
| [7-development.md](./7-development.md) | Branching, migrations, pre-commit gates, pull requests, deploys. | Before your first commit. |

## If you are new, in order

1. Read [1-overview.md](./1-overview.md).
2. Follow [2-quick-start.md](./2-quick-start.md) and run `./scripts/dev-setup/setup-local.sh`.
3. Skim [3-concepts.md](./3-concepts.md) and the landmarks tree in [4-visual-tree.md](./4-visual-tree.md).
4. Read [5-architecture.md](./5-architecture.md) before you write code, and
   [7-development.md](./7-development.md) before you commit.

## The other docs

`CLAUDE.md` has the coding rules and the security invariants. `CONTRIBUTING.md` covers setup and
conventions. The root `README.md` is the public front door. `docs/reference/` holds the few docs
that `CLAUDE.md` treats as required reading.

When two docs disagree, trust them in this order: the code, then `CLAUDE.md` and this guide, then
`README.md`, then the root `CONTEXT.md`. The root `CONTEXT.md` is frozen at February 2026 and is
history, not instruction.

These guides were generated from a full-repository analysis in August 2026. Where the code has
moved on, the code is right. Please fix the guide when you notice.
