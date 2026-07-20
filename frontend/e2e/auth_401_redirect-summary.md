# T16 — 401 auto-redirect e2e summary

### Scenario A
401 on /api/sessions → /auth/login?returnTo=/sessions

### Scenario B
Anonymous /sessions → /auth/me 401 → no redirect (loadUser caught it)

### Scenario C
?returnTo=//evil.com → verify → /sessions (open-redirect blocked)

