# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Layout

**Single-context.** One glossary and one ADR directory, both at the repo root:

```
/
├── CONTEXT.md        ← the glossary
├── docs/adr/         ← architecture decision records
└── lib/, app/, components/, supabase/
```

If this ever becomes a multi-package repo, the convention changes to a root
`CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context, with context-scoped
ADRs alongside each. That is not the case today.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: read any ADRs that touch the area you are about to work in.

Both exist. `docs/adr/` is intentionally empty until a decision is actually made
— an empty directory is not a gap to be filled speculatively.

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a
hypothesis, a test name — use the term as `CONTEXT.md` defines it, and avoid the
synonyms it explicitly rejects. This repo's terms are load-bearing: "resolution"
and "merge" mean different things, and so do "source" as a citation and "source"
as an edge endpoint.

If the concept you need is not in the glossary, that is a signal. Either you are
inventing language the project does not use (reconsider), or there is a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Writing ADRs

Number sequentially from `0001`, kebab-case the title, and record the decision
that was actually made along with the alternatives rejected and why. Record a
decision when it is made, not in advance of needing it.
