# v0.3.1 Full E2E Journey Test Report

_Test the entire user journey from landing to settle across all v0.3.1 features._

**Generated**: 2026-07-07T03:36:08.934Z

**Scope**: Anonymous + Logged-in + Multi-user via session_code

---

### 1. Anonymous landing page

![1. Anonymous landing page](full-e2e-01-landing.png)

Hero: 轻松分摊 + 2 buttons (直接开始使用 / 登录)

### 2. Join page (anon creator)

![2. Join page (anon creator)](full-e2e-02-join-page.png)

Auto-created session 4. Anonymous creator must claim "我" nickname.

### 3. Session detail (claimed)

![3. Session detail (claimed)](full-e2e-03-session-detail.png)

Alice claimed the placeholder nickname

### 4. Session with 2 bills

![4. Session with 2 bills](full-e2e-04-session-with-bills.png)

Dinner 810 CNY + Coffee 35 CNY

### 5. Settle page

![5. Settle page](full-e2e-05-settle.png)

CNY breakdown with 2 bills

### 6. /s/{code} → /sessions/{id}

![6. /s/{code} → /sessions/{id}](full-e2e-06-code-redirect.png)

Visited /s/D7VNEFJFCP → redirected to /sessions/4

### 7. Wizard Step 1

![7. Wizard Step 1](full-e2e-07-wizard-1.png)

给你的账本起个名字

### 8. Wizard Step 2

![8. Wizard Step 2](full-e2e-08-wizard-2.png)

一共有多少人

### 9. Wizard Step 3

![9. Wizard Step 3](full-e2e-09-wizard-3.png)

每个人叫什么名字

### 10. Wizard Step 3 filled

![10. Wizard Step 3 filled](full-e2e-10-wizard-3-filled.png)

Carol + Dave

### 11. After wizard confirm

![11. After wizard confirm](full-e2e-11-wizard-done.png)

Session 5 created with Carol (auto-claimed) + Dave (unclaimed). URL: http://localhost:8448/sessions/5

### 12. Creator's session view

![12. Creator's session view](full-e2e-12-creator-view.png)

Session 6, code WHPXJKRM62

### 13. Creator revisits via /s/{code}

![13. Creator revisits via /s/{code}](full-e2e-13-code-creator-redirect.png)

Creator visited /s/WHPXJKRM62 → redirected to /sessions/6 (auto-login via localStorage)

### 14. Invitee (not a member) via /s/{code}

![14. Invitee (not a member) via /s/{code}](full-e2e-14-invitee-not-member.png)

Fresh visitor → BE 403 → /s/{code} page shows "打不开" (invitee must claim via /join)

### 14. Anon button state

![14. Anon button state](full-e2e-15-anon-button.png)

直接开始使用 button visible

