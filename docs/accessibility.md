# Mobile App Accessibility Audit (WCAG 2.2 AA)

Audit of the BureauBridge Expo / React Native mobile application (`apps/mobile/`) against the Web Content Accessibility Guidelines (WCAG) 2.2 Level AA.

The application serves three distinct user roles (Payroll, Employee, Operations) with two visual themes (Light and Black/Mint Dark mode) and runs across native platforms and the web via `react-native-web`.

## Baseline Automated Scan

Initial automated testing using `@axe-core/playwright` across all primary views (Sign In, Home, Allocate, Activity with status history, Operations with reconciliation report) in both Light and Dark themes identified:
- **Critical violations:** 0
- **Serious violations:** 0
- **Moderate violations:** 2
  - `landmark-one-main`: Document does not have a main landmark.
  - `region`: Content outside landmark regions.

## Audit Findings

| # | Issue | WCAG 2.2 Criterion | Screen / Component | Planned Fix |
|---|---|---|---|---|
| 1 | Monetary values ("R250,00", "R99 500,00", "R321,09") lack phonetic descriptions and are pronounced ambiguously by screen readers | 1.1.1 Non-text Content, 3.1.2 Language of Parts | Global (`components.tsx`, `screens.tsx`) | Add `formatAmountForSpeech()` in `presentation.ts` and set descriptive `accessibilityLabel` on money values (e.g. "250 rand", "321 rand and 9 cents"). |
| 2 | Top navigation bar lacks a banner landmark role on web | 1.3.1 Info and Relationships, 2.4.1 Bypass Blocks | App Shell (`BureauApp.tsx`) | Add `accessibilityRole="banner"` / `role="banner"` to the header container. |
| 3 | Main scroll view content area lacks a main landmark role | 1.3.1 Info and Relationships, 2.4.1 Bypass Blocks | App Shell (`BureauApp.tsx`) | Add `accessibilityRole="main"` / `role="main"` to the scroll view container. |
| 4 | Employee selection radio buttons lack a containing `radiogroup` role and accessible group label | 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value | Allocate Screen (`screens.tsx`) | Wrap employee radio buttons in a container with `accessibilityRole="radiogroup"` / `role="radiogroup"` and `aria-label="Choose an employee"`. |
| 5 | Demo role selection buttons lack group semantics and container description | 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value | Sign In Screen (`screens.tsx`) | Add `accessibilityRole="radiogroup"` / `role="group"` with `aria-label="Choose demo role"` to the selector container. |
| 6 | Activity register status filter buttons lack explicit button roles and toolbar/group container label | 1.3.1 Info and Relationships, 4.1.2 Name, Role, Value | Activity Screen (`screens.tsx`) | Add `accessibilityRole="toolbar"` / `role="group"` with `aria-label="Filter allocations"` to container, and explicit `accessibilityRole="button"` with descriptive labels to buttons. |
| 7 | `ActionButton` lacks explicit `accessibilityRole="button"` and omits fallback label when `label` prop is omitted | 4.1.2 Name, Role, Value | Shared Components (`components.tsx`) | Add `accessibilityRole="button"`, default `accessibilityLabel` and `aria-label` to `label ?? children`, and provide `accessibilityState={{ disabled: !!disabled }}`. |
| 8 | `TextAction` buttons ("See all", "Refresh") lack contextual description when navigated out of flow | 2.4.4 Link Purpose (In Context), 4.1.2 Name, Role, Value | Home & Activity Screens (`components.tsx`, `screens.tsx`) | Add `label` prop to `TextAction`; pass "See all recent activity" on Home and "Refresh allocation register" on Activity. |
| 9 | Demo role selection buttons, password visibility toggle, filter buttons, and message dismiss button lack visible focus indicators on web | 2.4.7 Focus Visible | Sign In, Activity, App Shell (`screens.tsx`, `BureauApp.tsx`) | Add `focusStyle={{ outlineColor: "$accentStrong", outlineWidth: 2 }}` to all interactive pressables lacking focus styling. |
| 10 | Home screen balance hero card title lacks heading semantics for screen reader section navigation | 1.3.1 Info and Relationships, 2.4.6 Headings and Labels | Home Screen (`screens.tsx`) | Add `role="heading"` and `aria-level={2}` to "Employer prefunded balance" / "Your payable balance" text. |
| 11 | Status history timeline indicator uses `$accent` (#8DE4BD) on white card surface with insufficient contrast (1.50:1) | 1.4.11 Non-text Contrast | Activity Screen (`screens.tsx`) | Update timeline bar `borderLeftColor` to `$accentStrong` (6.86:1 in light mode, 12.25:1 in dark mode). |
| 12 | Border contrast on cards and input fields in light mode (#DCE5DF, 1.29:1) and dark mode (#343434, 1.49:1) | 1.4.11 Non-text Contrast | Palettes (`palettes.ts`) | Nudge `borderColor` in `palettes.ts` to enhance component boundary perception while preserving soft fintech aesthetic. |
| 13 | `TextAction` touch target dimensions not constrained to minimum 44×44 points | 2.5.8 Target Size (Minimum) | Shared Components (`components.tsx`) | Add `minWidth={44}` and `minHeight={44}` to `TextAction`. |
| 14 | System reduced motion preferences not explicitly observed for transitions and scrolling | 2.3.3 Animation from Interactions | App Shell & Providers (`BureauApp.tsx`, `AppearanceProvider.tsx`) | Query `AccessibilityInfo.isReduceMotionEnabled()` and `prefers-reduced-motion` media query to disable or bypass animations. |
| 15 | Automated regression suite lacks axe checks and pressable role/name assertions | 4.1.2 Name, Role, Value | Test Suite (`tests/mobile/`) | Add `@axe-core/playwright` test runner for all screens and assert every pressable has an accessible role and name. |
