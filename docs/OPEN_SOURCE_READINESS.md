# Open-source readiness — polish analysis

Snapshot for the public launch prep. Status after the sanitization PR: **much closer, not finished**.

## P0 — must finish before a public repo goes live

| Area | Status | Notes |
|------|--------|-------|
| License | Done in this PR | MIT added; README/private wording removed |
| Secrets / personal accounts in tree | Mostly done | Real emails, staging hosts, fixed invite tokens, Obsidian paths scrubbed from tracked sources |
| Public API email / invite leakage | Hardened | Preview masks emails; full invite token no longer on public preview; duplicate secret-returning route removed |
| Request validation logging | Hardened | No longer dumps full headers/body |
| Historical `SPEC.md` / one-off verify scripts | Removed | Replaced by `docs/ARCHITECTURE.md`; `frontend/scripts/*.cjs` deleted |
| Git history | **Still open** | Past commits may still contain PII/hosts. Prefer a fresh public orphan branch or history rewrite before advertising the public repo |
| Production cookie / secret defaults | Partial | Documented; still enforce fail-fast on placeholder `SECRET_KEY` in prod |

## P1 — strongly recommended

1. Add GitHub Actions: backend pytest + ruff, frontend `check` / unit / build, secret scan (gitleaks).
2. Fix Docker story: one process per service, real SvelteKit adapter, verified `build/index.js`.
3. Add root `Makefile` or documented task runner (README ports vs AGENTS were previously inconsistent).
4. Reduce mega-Svelte SFCs (`BillForm`, session page) and strip remaining dated UAT comments over time.
5. Make E2E refuse to run unless an explicit throwaway DB path is set.
6. Publish screenshots without personal fixture names; add real `screenshots/` or remove dead README links (already removed).

## P2 — polish

1. i18n or an explicit “Chinese-only product” badge (README already states Chinese-only).
2. Move `frontend/design-mocks/` (~20MB) to a design archive if the public clone should stay small.
3. Unify product naming (`轻均 FairLite` vs `split-bill-calculator` vs `sbc`) and a single version source.
4. CODE_OF_CONDUCT if you want community norms stated explicitly.
5. Accessibility pass on remaining svelte-check warnings.

## Intentionally out of scope for this PR

- Full comment scrub across every Svelte file (hundreds of historical UAT notes)
- Rewriting git history
- Completing Docker production packaging
- Adding English UI strings
