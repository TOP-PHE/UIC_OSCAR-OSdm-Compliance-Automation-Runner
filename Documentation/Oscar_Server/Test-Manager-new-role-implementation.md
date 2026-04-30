# OSCAR — Test Manager Role Feature Specification

**Date:** 2026-04-12
**Status:** Design complete, implementation pending
**Priority:** High — governance improvement for multi-user companies

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer)

"This material is copyrighted by UIC, Union Internationale des Chemins de fer (c) 2026 OSDM is a trademark belonging to UIC, and any use of this trademark is strictly prohibited unless otherwise agreed by UIC."

---

## 1. Objective

Introduce a **Test Manager** role at the company level that controls test configuration (framework, test data, shared scenarios) while allowing regular Testers to only run tests and define their own scenarios.

### Current Roles

| Role | Level | Can do |
|------|-------|--------|
| `administrator` | Platform | Manage all users, companies, view all runs, delete data |
| `certification_user` | Platform | Read-only access to all reports across all companies |
| `company_user` (Tester) | Company | Submit runs, view own runs, compare, manage company profile + test config |

### Problem
Today, any `company_user` can modify the test framework, test data (trains), and all scenarios. In a multi-user company, there's no way to control who defines the test configuration vs. who just runs tests.

---

## 2. New Role: `test_manager`

| Role | Level | Description |
|------|-------|-------------|
| `test_manager` | Company | Manages test framework, test data, and shared scenarios for their company |

### Role Hierarchy (company-level)

```
test_manager
  ├── Can do everything a company_user can do
  ├── PLUS: edit test framework (Section 1 of wizard)
  ├── PLUS: edit test data / train resources (Section 2 of wizard)
  ├── PLUS: create "shared scenarios" visible to all testers
  └── PLUS: delete any scenario (including tester-created ones)

company_user (Tester)
  ├── Submit runs (sequential or parallel)
  ├── View own runs, logs, artifacts
  ├── Compare runs
  ├── Create/edit/delete OWN scenarios only
  ├── Use shared scenarios (read-only, cannot modify)
  ├── View test framework (read-only)
  └── View test data (read-only)
```

---

## 3. Permission Matrix

| Action | administrator | test_manager | company_user | certification_user |
|--------|:---:|:---:|:---:|:---:|
| **Company Profile (API config)** |
| View API config | Yes | Yes | Yes | No |
| Edit API config (endpoint, token) | Yes | Yes | Yes | No |
| **Test Framework (Section 1)** |
| View framework | Yes | Yes | Yes (read-only) | No |
| Edit framework | Yes | Yes | No | No |
| Delete framework | Yes | Yes | No | No |
| **Test Data / Trains (Section 2)** |
| View trains | Yes | Yes | Yes (read-only) | No |
| Add/edit/delete trains | Yes | Yes | No | No |
| **Scenarios (Section 3)** |
| View all scenarios | Yes | Yes | Yes | No |
| Create own scenario | Yes | Yes | Yes | No |
| Edit own scenario | Yes | Yes | Yes | No |
| Delete own scenario | Yes | Yes | Yes | No |
| Create shared scenario | Yes | Yes | No | No |
| Edit shared scenario | Yes | Yes | No | No |
| Delete shared scenario | Yes | Yes | No | No |
| Delete any scenario | Yes | Yes | No | No |
| Use shared scenario (run) | Yes | Yes | Yes | No |
| **Runs** |
| Submit run | Yes | Yes | Yes | No |
| View own runs | Yes | Yes | Yes | No |
| Delete own runs | Yes | Yes | Yes | No |
| **Data File** |
| Save data file | Yes | Yes | Yes* | No |
| Upload data file | Yes | Yes | No | No |
| Delete data file | Yes | Yes | No | No |

*Testers can save the datafile only when adding/editing their own scenarios (the save applies to the full datafile including shared scenarios they cannot modify).

---

## 4. Shared Scenarios

### 4.1 Concept

A **shared scenario** is a scenario created by a Test Manager that is visible and usable by all testers in the same company. Testers can:
- See shared scenarios in their scenario list
- Include shared scenarios in `scenariosToRun` when submitting runs
- View shared scenario details (read-only — all fields greyed out)
- **Cannot** modify, delete, or duplicate-and-modify shared scenarios

### 4.2 Data Model

Add a `created_by` and `shared` flag to each scenario in the datafile:

```json
{
  "scenarios": [
    {
      "code": "OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG",
      "shared": true,
      "created_by": "testmanager@company.com",
      "scenarioType": "REFUND",
      ...
    },
    {
      "code": "MY_CUSTOM_SCENARIO",
      "shared": false,
      "created_by": "tester@company.com",
      "scenarioType": "SALE",
      ...
    }
  ]
}
```

### 4.3 Visual Distinction

Shared scenarios should be clearly marked in the UI:

- **Badge**: A distinct "Shared" or "Template" badge on the scenario row (e.g. blue pill with lock icon)
- **Background**: Slightly different row background color (e.g. light blue tint)
- **Lock icon**: Alongside the scenario code for testers (indicating read-only)
- **Creator**: Show "Created by: testmanager@company.com" in the scenario detail

For testers viewing a shared scenario:
- All form fields are **disabled/greyed out**
- No delete button
- No "Save" capability
- A message: "This scenario is managed by your Test Manager and cannot be modified."

---

## 5. Implementation Plan

### 5.1 Database Changes

```sql
-- Add test_manager to allowed roles (no schema change needed — role is TEXT)
-- Just update validation in auth.js and admin.js
```

The `users.role` column is already `TEXT` — no migration needed. Just add `'test_manager'` to the `ALLOWED_ROLES` set in auth.js and admin.js.

### 5.2 Backend Changes

#### auth.js + admin.js
- Add `'test_manager'` to `ALLOWED_ROLES` set
- `normalizeRole()` should recognize `test_manager`

#### middleware/auth.js
- `isPlatformRole()` should NOT include `test_manager` (it's company-level)
- Add `isTestManager(role)` helper: returns true for `test_manager` and `administrator`

#### company.js — Test Framework Routes
- `PUT /v1/company/test-framework`: Check role — reject if `company_user`
- `DELETE /v1/company/test-framework`: Check role — reject if `company_user`
- `POST /v1/company/test-resources`: Check role — reject if `company_user`
- `PUT /v1/company/test-resources/:id`: Check role — reject if `company_user`
- `DELETE /v1/company/test-resources/:id`: Check role — reject if `company_user`
- `POST /v1/company/datafile` (upload): Check role — reject if `company_user`
- `DELETE /v1/company/datafile`: Check role — reject if `company_user`
- GET routes: No change (all company roles can read)

#### company.js — Datafile JSON Save
- `PUT /v1/company/datafile/json`: Allow for both `test_manager` and `company_user`
- When `company_user` saves: validate that they haven't modified any `shared: true` scenarios
- When `test_manager` saves: full access, can set `shared: true` on scenarios

### 5.3 Frontend Changes

#### scenarios.html
- Read user role from `localStorage`
- **If `company_user` (Tester):**
  - Section 1 (Framework): render as read-only (all inputs disabled, no save button)
  - Section 2 (Test Data/Trains): render as read-only (no add/edit/delete buttons)
  - Section 3 (Scenarios):
    - Shared scenarios: render with lock badge, all fields disabled, no delete button
    - Own scenarios: full edit access (unchanged)
    - Wizard: cannot set `shared: true` (checkbox hidden)
- **If `test_manager`:**
  - Full access to all sections (unchanged from current behavior)
  - Wizard: can toggle `shared: true` on new scenarios
  - Can delete any scenario (own or others')

#### admin.html
- Add `test_manager` to the role dropdown when creating/editing users
- Show role badge for test managers

#### nav.js
- Update `roleMeta()` to handle `test_manager` with appropriate badge/color

### 5.4 Scenario Ownership

When generating a scenario via the wizard:
- Add `created_by: req.user.email` to the scenario object in the datafile
- Add `shared: false` by default for `company_user`
- Add `shared: true` option (checkbox) for `test_manager`

When rendering the scenario list:
- Show creator email in the scenario row subtitle
- Show "Shared" badge for `shared: true` scenarios
- Tester can only delete scenarios where `created_by === user.email && !shared`

---

## 6. Files to Modify

| File | Changes |
|------|---------|
| `src/api/routes/auth.js` | Add `test_manager` to ALLOWED_ROLES |
| `src/api/routes/admin.js` | Add `test_manager` to ALLOWED_ROLES |
| `src/api/middleware/auth.js` | Add `isTestManager()` helper, update role checks |
| `src/api/routes/company.js` | Add role checks on write endpoints for framework/resources/datafile |
| `public/scenarios.html` | Read-only mode for testers on framework/trains, shared scenario badges, ownership tracking |
| `public/admin.html` | Add test_manager to role dropdown |
| `public/nav.js` | Add test_manager role metadata (badge, color) |

---

## 7. Migration Path

1. Existing `company_user` accounts continue to work unchanged (full access for now)
2. Admin creates `test_manager` accounts for designated users
3. Test Manager sets up framework + trains + shared scenarios
4. Testers see framework/trains as read-only and shared scenarios with lock badge
5. Testers can still create their own scenarios alongside shared ones

---

## 8. UI Mockups

### Scenario List — Tester View

```
+------------------------------------------------------------------+
| Scenarios                                                         |
|                                                                   |
| [x] OTST_RFND_PATCH_1ADT_1LEG  🔒 Shared  REFUND  PATCH         |
|     Created by: testmanager@benerail.com                          |
|                                                                   |
| [x] OTST_EXCH_1ADT_1LEG        🔒 Shared  EXCHANGE              |
|     Created by: testmanager@benerail.com                          |
|                                                                   |
| [x] MY_CUSTOM_TEST              ✏️ Yours   SALE                  |
|     Created by: tester@benerail.com                     [🗑 Del]  |
|                                                                   |
| [+ Add Scenario]                                                  |
+------------------------------------------------------------------+
```

### Framework Section — Tester View

```
+------------------------------------------------------------------+
| 🔒 Test Framework (managed by Test Manager — read-only)           |
|                                                                   |
| OSDM Version: 3.8                          [greyed out]           |
| Concurrent Sessions: 3                     [greyed out]           |
| Sales Flows: SALE, REFUND, EXCHANGE        [greyed out]           |
| ...                                                               |
+------------------------------------------------------------------+
```

### Shared Scenario Detail — Tester View

```
+------------------------------------------------------------------+
| 🔒 OTST_RFND_PATCH_1ADT_1LEG                                     |
| Created by: testmanager@benerail.com                              |
| ⚠️ This scenario is managed by your Test Manager.                |
|    You can include it in your runs but cannot modify it.          |
|                                                                   |
| ⚙️ Scenario Parameters         [all fields disabled/greyed]      |
| 🚂 Trip                        [all fields disabled/greyed]      |
| 🔍 Offer Search Criteria       [all fields disabled/greyed]      |
| ...                                                               |
+------------------------------------------------------------------+
```

---

## 9. Open Questions

1. **Can a tester duplicate a shared scenario?** (Create a personal copy they can modify) — Suggested: Yes, with a "Duplicate" button that creates a non-shared copy under their name.

2. **Can a test manager see and manage tester-created scenarios?** — Suggested: Yes, test manager has visibility and delete rights on all scenarios.

3. **Should `scenariosToRun` mixing be allowed?** — Can a tester include both shared and personal scenarios in the same run? — Suggested: Yes, the `scenariosToRun` array just lists codes regardless of ownership.

4. **Notification on shared scenario change?** — When a test manager modifies a shared scenario, should testers be notified? — Suggested: No for now, keep it simple.
