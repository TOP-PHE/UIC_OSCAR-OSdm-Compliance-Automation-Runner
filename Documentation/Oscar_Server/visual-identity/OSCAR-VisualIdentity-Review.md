# OSCAR

## UIC Visual Identity Review

Web application - oscar-server public pages  
April 2026 | UIC OSDM OTST Working Group

## Scope

6 HTML pages reviewed:

- index.html (Login)
- dashboard.html
- run.html (New Run)
- run-detail.html
- profile.html
- compare.html

## Guideline

UIC Visual Identity 2024 - colours, typography, and icon usage derived from `2024_UIC template.potx` and the OSCAR icon-preview document.

## Result

10 issue types identified. All pages share the same 5 critical deviations (colour, typography, icon). The compare page has 2 additional high issues. All are correctable via a single shared CSS update.

## 1. UIC 2024 Brand Palette

The following seven colours constitute the official UIC 2024 brand palette, as documented in `2024_UIC template.potx` and applied in the OSCAR icon design. All OSCAR web pages must use exclusively these colours for UI elements.

| Colour | Hex |
|---|---|
| Primary Blue | `#0090D4` |
| Dark Blue | `#005A8A` |
| Amber / Gold | `#FCC44D` |
| Teal | `#00A3B0` |
| Green | `#62B576` |
| Charcoal | `#3C3C3B` |
| Light Gray | `#F2F2F2` |

Typography: Arial Black for headings and bold labels; Arial (Regular) for all body text and UI elements. Segoe UI is not part of the UIC standard - it should not be set as the preferred font.

## 2. Common Findings (All 6 Pages)

The following five issues appear identically across every page and should be resolved via a shared CSS variable or common stylesheet update.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | All pages | Primary/brand colour | `#1a3a6b` (dark navy) | `#0090D4` (UIC blue) |
| HIGH | All pages | Logo/brand mark in navbar | `OSCAR` text + emoji placeholder | OSCAR SVG icon 24px |
| MEDIUM | All pages | Body font stack | `'Segoe UI', Arial` | `Arial, sans-serif` |
| MEDIUM | All pages | Body text colour | `#222` | `#3C3C3B` (UIC charcoal) |
| MEDIUM | All pages | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC neutral) |
| LOW | All pages | Browser tab favicon | none set | `<link rel="icon" href="/oscar-icon.svg">` |

## 3. Page-by-Page Review

### index.html - Login

The login page has adequate functional layout but diverges from UIC brand on colour, typography, and icon/logo usage.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | index.html - Login | Primary colour - nav and buttons | `#1a3a6b` (dark navy) | `#0090D4` (UIC blue) |
| HIGH | index.html - Login | Active tab indicator colour | `#1a3a6b` (dark navy) | `#0090D4` (UIC blue) |
| HIGH | index.html - Login | Input focus border | `#1a3a6b` (dark navy) | `#0090D4` (UIC blue) |
| HIGH | index.html - Login | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon + wordmark |
| MEDIUM | index.html - Login | Button hover background | `#12296b` | `#005A8A` (UIC dark blue) |
| MEDIUM | index.html - Login | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | index.html - Login | Body text colour | `#222` | `#3C3C3B` (UIC charcoal) |
| MEDIUM | index.html - Login | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| LOW | index.html - Login | No favicon / `<link rel="icon">` | absent | `oscar-icon.svg` as favicon |

### dashboard.html - Dashboard

Functional dashboard. Same colour deviations throughout; additionally uses an out-of-palette purple for the Compare feature.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | dashboard.html - Dashboard | Navbar background | `#1a3a6b` (dark navy) | `#0090D4` (UIC blue) |
| HIGH | dashboard.html - Dashboard | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon |
| HIGH | dashboard.html - Dashboard | Compare button colour | `#7b1fa2` (purple) | `#00A3B0` (UIC teal) |
| HIGH | dashboard.html - Dashboard | Compare hover / disabled | `#6a1b9a` / `#ce93d8` | `#005A8A` / `#A0D4DA` |
| MEDIUM | dashboard.html - Dashboard | H2 heading colour | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | dashboard.html - Dashboard | Primary button (New Run) | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | dashboard.html - Dashboard | Compare bar background | `#f3e5f5` (lavender) | `#E5F5F7` (light teal tint) |
| MEDIUM | dashboard.html - Dashboard | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | dashboard.html - Dashboard | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| LOW | dashboard.html - Dashboard | No favicon | absent | `oscar-icon.svg` as favicon |

### run.html - New Run

The run-launch page uses a Material Design green for the primary action button, which is not in the UIC palette.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | run.html - New Run | Navbar background | `#1a3a6b` | `#0090D4` (UIC blue) |
| HIGH | run.html - New Run | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon |
| HIGH | run.html - New Run | Launch button background | `#2e7d32` (MD green) | `#62B576` (UIC green) |
| HIGH | run.html - New Run | Launch button hover | `#1b5e20` | `#4A9E62` |
| MEDIUM | run.html - New Run | H2 heading colour | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | run.html - New Run | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | run.html - New Run | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| LOW | run.html - New Run | No favicon | absent | `oscar-icon.svg` as favicon |

### run-detail.html - Run Detail

Log/detail view is functionally strong. The dark terminal log box is acceptable for readability. Key deviations are brand colour and logo.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | run-detail.html - Run Detail | Navbar background | `#1a3a6b` | `#0090D4` (UIC blue) |
| HIGH | run-detail.html - Run Detail | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon |
| HIGH | run-detail.html - Run Detail | H2 and Download button colour | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | run-detail.html - Run Detail | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | run-detail.html - Run Detail | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| LOW | run-detail.html - Run Detail | No favicon | absent | `oscar-icon.svg` as favicon |

### profile.html - Company Profile

Profile/settings page. Identical primary brand colour issues; secondary buttons also need review.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | profile.html - Company Profile | Navbar background | `#1a3a6b` | `#0090D4` (UIC blue) |
| HIGH | profile.html - Company Profile | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon |
| HIGH | profile.html - Company Profile | Primary button and focus | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | profile.html - Company Profile | H2 heading colour | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | profile.html - Company Profile | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | profile.html - Company Profile | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| MEDIUM | profile.html - Company Profile | Upload dashed border hover | `#1a3a6b` | `#0090D4` (UIC blue) |
| LOW | profile.html - Company Profile | No favicon | absent | `oscar-icon.svg` as favicon |

### compare.html - Report Comparison

Comparison view. The most complex page with rich filter UI. Primary colour and non-UIC purple urgently need correction.

| Severity | Page | Issue | Current | Recommended |
|---|---|---|---|---|
| HIGH | compare.html - Report Comparison | Navbar background | `#1a3a6b` | `#0090D4` (UIC blue) |
| HIGH | compare.html - Report Comparison | Logo - emoji placeholder | emoji placeholder | OSCAR SVG icon |
| HIGH | compare.html - Report Comparison | H2 heading colour | `#1a3a6b` | `#0090D4` (UIC blue) |
| MEDIUM | compare.html - Report Comparison | Body font family | `'Segoe UI', Arial` | `Arial` (UIC standard) |
| MEDIUM | compare.html - Report Comparison | Page background colour | `#f0f2f5` | `#F2F2F2` (UIC gray) |
| LOW | compare.html - Report Comparison | No favicon | absent | `oscar-icon.svg` as favicon |

## 4. Status Colour System

The status badges (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`) currently use Material Design colours. The table below maps each status to a UIC-aligned alternative while preserving clear semantic meaning.

| Status | Current BG | Current Text | UIC BG | UIC Text | Rationale |
|---|---|---|---|---|---|
| QUEUED | `#e3f2fd` | `#1565c0` | `#E5F0F8` | `#0090D4` | UIC blue tint |
| RUNNING | `#fff8e1` | `#e65100` | `#FFF8E1` | `#E65100` | Amber warning - acceptable |
| COMPLETED | `#e8f5e9` | `#2e7d32` | `#EBF5EE` | `#62B576` | UIC green tint |
| FAILED | `#ffebee` | `#c62828` | `#FFEBEE` | `#C62828` | Red - no UIC equivalent, retain |
| CANCELLED | `#eceff1` | `#546e7a` | `#ECEFF1` | `#546E7A` | Neutral - acceptable |

## 5. OSCAR Icon - Assessment

The OSCAR icon (`oscar-icon.svg` / `oscar-icon.png`) in the OSCAR Web site folder is compliant with UIC 2024 visual identity. It correctly uses the full UIC 2024 colour scheme:

- UIC Blue `#0090D4`: main circular background gradient; anchors to UIC primary brand colour
- UIC Amber `#FCC44D`: central gold star; references the Oscar award and UIC accent colour
- White: checkmark (conformance) and gear teeth details; correct contrast on blue
- Dark Blue `#005A8A`: deep stop in the radial gradient; aligns with UIC secondary blue

Recommended action: replace the navbar text+emoji placeholder on all six pages with an `<img>` tag referencing `/oscar-icon.svg` at `28x28 px`, alongside the OSCAR wordmark in Arial Black. Add `<link rel="icon" href="/oscar-icon.svg">` in every `<head>` to display the icon in the browser tab.

## 6. Recommended Implementation Plan

All colour and typography changes can be delivered in a single shared CSS block (or CSS variables) added to each page. The effort is low with maximum visual impact.

| Priority | Effort | Change | Pages Affected | Impact |
|---|---|---|---|---|
| 1 | 5 min | Replace `#1a3a6b` -> `#0090D4` across all CSS (global find and replace) | All 6 | HIGH - instantly aligns brand colour |
| 2 | 10 min | Swap navbar placeholder for `<img src="/oscar-icon.svg">` + OSCAR text in Arial Black | All 6 | HIGH - correct logo usage |
| 3 | 5 min | Add `<link rel="icon" href="/oscar-icon.svg">` to all `<head>` blocks | All 6 | MEDIUM - browser tab branding |
| 4 | 5 min | Replace `#12296b` hover -> `#005A8A`, `#7b1fa2` compare purple -> `#00A3B0` | All 6 + dashboard | HIGH - removes off-palette purple |
| 5 | 5 min | Replace `#2e7d32` run button -> `#62B576` (UIC green) | run.html | MEDIUM - UIC palette alignment |
| 6 | 5 min | Change `font-family: 'Segoe UI', Arial` -> `Arial, sans-serif` on body | All 6 | MEDIUM - typography standard |
| 7 | 2 min | Change body background `#f0f2f5` -> `#F2F2F2`, body colour `#222` -> `#3C3C3B` | All 6 | LOW - subtle but correct |