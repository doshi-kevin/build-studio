---
paths:
  - "src/app/api/professor-assistant/**"
  - "src/app/api/assignment-assistant/**"
  - "src/lib/ai/professor-assistant/**"
  - "src/lib/ai/assignment-assistant/**"
  - "src/components/professor/assistant/**"
---

# Athena Cost Awareness

`docs/reference/athena-cost-analysis.md` is the team's living record of Athena's average cost per query and the cost-vs-worth framework for deciding whether a task belongs in Athena at all.

- **Before designing a new Athena tool, surface, or capability**: read `docs/reference/athena-cost-analysis.md` and apply its 4-step framework (deterministic alternative? monthly bill? prompt tax? value ≥ bill?). Surface the estimated cost in the design/plan.
- **After shipping a new Athena tool, surface, or model change**: update `docs/reference/athena-cost-analysis.md` per its "Keeping this doc alive" section (new `feature` labels go into its SQL; re-run and refresh the table).
- New Athena surfaces must log via `recordAiUsage` with a stable `feature` label — an unmetered surface breaks this analysis.
