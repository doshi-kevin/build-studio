---
name: mermaid
description: Guide for creating Mermaid diagrams. Use when the user wants to create a Mermaid diagram or update an existing one — e.g. a first-pass system-design sketch for a feature.
---

# Mermaid Diagram Skill

Create, validate, and refine Mermaid diagrams from natural-language descriptions,
code, or by editing existing diagrams. _(Adapted from DZunke's "mermaid" skill for
in-repo, team-wide use — committed here so everyone gets it on pull, no plugin needed.)_

## Core workflow

1. **Understand the request** — identify the diagram type (flowchart, sequence, class,
   ER, state, C4/architecture, etc.) and extract the key elements: entities,
   relationships, flow, hierarchy. Decide whether you're creating new or editing an
   existing diagram.

2. **Generate Mermaid code** — write syntactically correct Mermaid for the chosen type.
   Use meaningful node IDs, clear labels, `subgraph`s to group related parts, and
   `classDef`s for consistent styling. Quote any label that contains spaces or special
   characters. Avoid raw `<`/`>` inside labels (use `&lt;`/`&gt;` or reword).

3. **Save to a file** — write the diagram into the relevant doc (e.g. a `docs/designs/`
   markdown file) or a standalone `.mmd` file named for its purpose in kebab-case
   (e.g. `quiz-system-design.mmd`).

4. **Validate (optional)** — if `mmdc` (mermaid-cli) is installed, validate with
   `mmdc -i <file>.mmd`. On this team, diagrams are normally rendered via the VS Code
   "Markdown Preview Mermaid Support" extension or on GitHub, so if `mmdc` isn't
   available, **skip CLI validation — never block on it.**

5. **Auto-correct errors** — if validation fails, read the error (line number + issue)
   and fix common problems: bad arrow syntax, unquoted labels with spaces, malformed
   node definitions, invalid keywords. Re-save and re-validate until it passes.

6. **Render on request only** — render to an image only when the user explicitly asks:
   `mmdc -i <file>.mmd -o <file>.svg` (or `.png` / `.pdf`).

## Supported diagram types

Flowchart, sequence, class, state, entity-relationship (ER), gantt, user journey,
timeline, pie, quadrant, git graph, C4, architecture, block, mindmap, requirement, and
others. Use your knowledge of each type's Mermaid syntax.

## Best practices

- Keep each diagram focused — split a large one into smaller diagrams rather than cramming.
- Pick one orientation (top-to-bottom or left-to-right) and stay consistent.
- Colour-code with `classDef` by kind of node (people / screens / logic / data / external) so the picture reads at a glance.
- **For system designs specifically:** show the important logic as its own labelled boxes — don't hide it inside a vague "backend" block — name the technologies used, and keep it plain enough for a non-engineer to follow. Follow the rules and template in `docs/reference/system-design-rules.md`.

## Output format

Show the file path and the Mermaid code in a fenced ` ```mermaid ` block. If you
rendered an image, show its path too.
