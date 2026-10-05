# Soft fintech mobile experience

BureauBridge uses **Tamagui** for the Expo interface on Android, iOS, and web. The layout pairs a rounded dashboard with bottom tabs, a mint balance card, clear status labels, and a dedicated allocation form.

First launch uses **light mode**, including when the device prefers dark mode. The moon/sun button switches appearance. The choice is saved on the device and survives a reload or sign-out. Dark mode uses black surfaces with the same mint accent.

## Palette

| Token | Light | Dark |
| --- | --- | --- |
| App background | `#F4F7F5` | `#050505` |
| Card surface | `#FFFFFF` | `#141414` |
| Main text | `#182C24` | `#F0F5F2` |
| Muted text | `#576A60` | `#AFBBB4` |
| Mint accent | `#8DE4BD` | `#8DE4BD` |
| Text on mint | `#122E22` | `#122E22` |

Semantic warning, decline, and posted colours also adapt to appearance. Every allocation status has a text label. System fonts scale with the device; controls use at least 44-point targets, visible focus styles, and accessible names. Safe-area insets protect the bottom tabs, and the iOS keyboard follows the selected appearance.

## Views

| Role | Tabs | Capabilities |
| --- | --- | --- |
| Payroll | Home, Allocate, Activity | Employer and employee balances, internal allocation form, register and status history |
| Employee | Home, Activity | Own payable balance, own allocations and history |
| Operations | Home, Allocate, Activity, Ops | Payroll capabilities plus core inquiry, verified resumption, saved reconciliation and CSV export |

The Home balance comes from the API's core projection and shows its observation time in Johannesburg time. Recent activity appears before the employee balance list. The Activity register can show all, in-progress, or completed allocations.

The form persists an unfinished request **before transmission**. A failed send locks the employee and amount; retry, including after an app restart and sign-in, preserves the original UUID and integer-cent payload. The amount field accepts a decimal point or comma, rejects grouping separators, and submits integer cents. An acknowledged submission opens Activity. Signing out clears session data from the screen while retaining an unfinished request for that user.

## Source map

| File | Responsibility |
| --- | --- |
| `apps/mobile/App.tsx` | App entry and appearance provider |
| `apps/mobile/tamagui.config.ts` | Typed Tamagui configuration and themes |
| `apps/mobile/src/palettes.ts` | Shared semantic colours |
| `apps/mobile/src/AppearanceProvider.tsx` | Light-first preference, persisted toggle and system surfaces |
| `apps/mobile/src/BureauApp.tsx` | Header, feedback and role-aware bottom tabs |
| `apps/mobile/src/screens.tsx` | Sign-in, Home, Allocate, Activity and operations views |
| `apps/mobile/src/components.tsx` | Shared cards, controls, typography and status badges |
| `apps/mobile/src/useBureau.ts` | Sessions, API actions, polling and retry persistence |
| `tests/mobile/app.spec.ts` | Browser interaction checks against an isolated API fixture |

## Local checks and captures

```powershell
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run test:mobile:web
npm run export --workspace @bureau/mobile
```

The browser command exports the web app and starts a local-only static server. Requests to the API are intercepted with fictional test fixtures; no running SQL Server or demo credentials are needed. It checks default/saved appearance, masked passwords, retry persistence after restart, role views, history, recovery controls, CSV download, and a 320-pixel phone layout. API authorization is separately covered by the server tests.

For a reproducible README capture on Bash:

```bash
EXPO_PUBLIC_API_URL=http://localhost:3000 EXPO_NO_TELEMETRY=1 BUREAU_CAPTURE_UI=1 npm run test:mobile:web
```

The screenshots are browser captures using those fixtures. They establish the implemented design; Android/iOS device UI, keyboards, networking, and native sharing still need native acceptance.

This work is isolated on `feature/mobile-soft-fintech`. Its focused commits use `[skip ci]` as requested; validation is local. The existing workflow and historical server validation remain available on `main`.
