# docs/

Two folders here are in git.

| Folder | What's in it |
|---|---|
| [`reference/`](./reference/) | The handful of docs that `CLAUDE.md` and `.claude/rules/` treat as required reading. Deliberately small: system design rules, user research signals, Athena cost analysis. |
| [`onboarding/guide/`](./onboarding/guide/) | A seven-part walkthrough of the codebase for someone new. Start there, not here. |

Anything else you see under `docs/` is local to the machine you are reading this on. It is not
part of the repo, and a fresh clone will not have it.

## Where does a new doc go?

- **A doc an agent must read before a class of work** goes in `reference/`, and you add the
  pointer to `CLAUDE.md` or the matching `.claude/rules/` file in the same commit. Nothing reads
  a doc that nothing links to.
- **A changed route, table, command, env var, or architectural pattern** means updating the one
  affected file in `onboarding/guide/`. Just that file. Do not regenerate the set.
- **A feature's system design** follows
  [`reference/system-design-rules.md`](./reference/system-design-rules.md), which carries the
  standard and the template.

## Conventions

Filenames are kebab-case. No snake_case and no SCREAMING_CASE, except `README.md`.

Every system design carries a status header, explained in `reference/system-design-rules.md`. A
design that claims to describe the code but does not is worse than no design, because someone
will build against it.

Moving a doc means fixing the things that point at it, in the same commit. A previous restructure
skipped this and left dead paths in six migration comments.
