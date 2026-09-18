@AGENTS.md

## Agent skills

### Issue tracker

Issues live as GitHub issues in `annamariadominic/entity-explorer`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Git commit discipline

For implementation work, make a few small logical commits at stable milestones rather than one large commit at the end of a ticket.

Each commit must:

- represent one coherent change
- leave the repository in a working state
- have tests/typechecking passing when applicable
- avoid mixing unrelated changes

Do not commit after every file or trivial edit.

For a multi-step ticket, prefer 2-4 commits when the work naturally divides into stable milestones.

Use the issue-closing keyword only in the final commit for that ticket.
