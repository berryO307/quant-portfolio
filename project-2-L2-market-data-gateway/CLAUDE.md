# Project Conventions

## Architecture

This repo has two tracks:

- **C++ market-data gateway** (existing, hot path) — must never be slowed
  down.
- **UI/visualization layer** — split into a native ImGui tool and a
  Next.js web replay app.

## Hot-path rule

Never modify hot-path code to add UI, logging, or serialization work
directly in the trading/gateway thread. All UI-facing data must be handed
off through a lock-free ring buffer to a separate thread/process.

## Workflow

- Work in small, single-purpose PRs. One capability per PR, not multiple.
- Branch naming: `feature/<short-name>`. No direct commits to `main`.
- Commit messages: conventional commits style (`feat:`, `fix:`, `refactor:`,
  `docs:`).
- Before implementing, briefly explain the approach and any tradeoffs, then
  wait for confirmation before writing code.

## Bug tracking during inspection

When the user says to "track this bug" (or similar — "add this to the bug
tracker", "log this bug"), append an entry to `BUGS.md` at the project-2
root instead of just fixing it silently. Follow the format already in that
file: a numbered entry with Where/Symptom/Investigation, and a `/fix` line
holding the resolution (`/fix: (pending)` until one exists). Do not commit
`BUGS.md` or the fixes it describes unless the user explicitly asks —
it's a scratch log for a batch review, kept out of git until the user says
the round of bugs is done and wants to mass-commit. If `BUGS.md` doesn't
exist yet, create it using the same format.

## Versioning

Semantic versioning via git tags, namespaced as `project-2-vMAJOR.MINOR.PATCH`
(this repo is a monorepo shared with project-1, and git tags are repo-wide —
the `project-2-` prefix keeps this project's version history independent of
project-1's tags):

- **PATCH** — bug fix.
- **MINOR** — new capability that doesn't break the sample/schema format
  between C++ and UI.
- **MAJOR** — breaking change to that format.
