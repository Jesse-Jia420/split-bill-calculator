# Contributing

Thanks for helping improve SplitIt.

## Development setup

Follow the Quick start in [`README.md`](README.md). Use `backend/.env.example` as the source of truth for backend settings.

## Pull requests

1. Create a focused branch for one change.
2. Keep diffs small and related to the request.
3. Run what you can locally:
   - `cd backend && python -m pytest tests/ -q`
   - `cd frontend && npm run check`
4. Describe *what* changed and *why* in the PR body.
5. Do not commit secrets, real emails, private hostnames, or personal test accounts.

## Code style

- **Backend:** Python 3.11+, prefer clear names over cleverness. Run `ruff check app/` when possible.
- **Frontend:** Svelte 5 runes, TypeScript. Prefer existing design tokens / components over new one-offs.
- **Comments:** Explain non-obvious intent. Avoid dated process logs, personal names, or ticket dump commentary.

## Scope notes

- UI copy is currently Chinese-only; do not half-translate unless the PR is an i18n effort.
- Canonical session URLs are `/s/{code}`; `/sessions/{id}` remains for compatibility.
