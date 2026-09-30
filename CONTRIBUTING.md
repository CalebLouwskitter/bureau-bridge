# Working on BureauBridge

Start with the [README](README.md), [development guide](docs/development.md), and [architecture decisions](docs/adr/0001-ledger-authority.md). The project uses Node.js 24, npm workspaces, Docker Linux containers, PHP, Python, and GnuCOBOL.

## Keep the boundaries clear

- Represent monetary amounts as integer minor units. The current currency is ZAR.
- Keep ledger mutations in the COBOL core. Modern account values are read projections with source metadata.
- Preserve request references across retries and recovery. Reject a reference reused with different data.
- Treat `POSTED` and `DECLINED` as final. A timeout or pending import needs verification.
- Keep the fixed-width layout and its documentation together when changing the boundary.
- Keep generated credentials, data volumes, build output, and signing files out of commits.

## Verification routes

| Change | Relevant checks |
| --- | --- |
| TypeScript API/worker/contracts | `npm run typecheck`, `npm test` |
| COBOL or core wrapper | `npm run test:core` on Linux with GnuCOBOL |
| PHP intake/export/import | PHP lint, `tests/legacy_integration.php`, server `test:legacy-http` against a disposable legacy runtime |
| SQL store or migrations | Server `test:sql` against SQL Server with the worker stopped and an empty outbox |
| Cross-system behavior | `npm run smoke` against a disposable complete stack |
| Expo | TypeScript and platform export, then a relevant device check |

The [validation record](docs/validation.md) explains the distinction between isolated checks, real legacy runtime checks, and remaining acceptance gates. State what was actually run in a pull request.

## Changes for review

Explain the triggering scenario, the resulting behavior, and the evidence for it. Keep schema changes idempotent and preserve existing demo volumes when practical. The v0.1 core upgrade fixture is available for compatibility checks.

Fictional data and local demo identities are deliberate. Employer catalogs, external payouts, production identity, and deployment are separate project slices.
