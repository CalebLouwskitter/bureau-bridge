# Validation evidence — v0.2

Second review performed on 30 September 2026. No external repository or deployment was created.

| Check                                           | Result                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript: API, worker, contracts, Expo        | Passed                                                                                                                                                                                 |
| API/worker/contracts/reconciliation suite       | 14 tests passed, including immutable final outcomes, damaged retry-cache handling, ownership/roles, discrepancy detection, incomplete scans, and CSV escaping                          |
| Actual GnuCOBOL core suite                      | 7 tests passed: parallel replay, conflict, declines/suspension, failures before/after publication, read-only audit/snapshot, and v0.1 indexed-file upgrade preserving balances/journal |
| PHP syntax                                      | All 5 application PHP files and the integration test passed                                                                                                                            |
| Real PHP + MariaDB + COBOL integration          | Passed normal posting, intake replay/conflict, lost-result inquiry, verified unposted resumption, suspended decline, batch controls, CSV escaping, immutable final posting ID          |
| Real HTTP boundary and TypeScript legacy client | Passed account snapshots, inventory parsing, journal/balance reconciliation, authenticated CSV reports, operator session/form token, and bridge/operations credential isolation        |
| Expo platform exports                           | Web JavaScript plus Android/iOS Hermes bundles passed                                                                                                                                  |
| Native configuration introspection              | Development HTTP permitted; production HTTP exception disabled; production config rejects a non-HTTPS API URL                                                                          |
| Current Compose configuration                   | Passed `docker compose config --quiet` using Compose 2.40.3; this does not establish image build/startup                                                                               |
| Docker images/startup                           | Not run: no Docker daemon available                                                                                                                                                    |
| SQL Server migration/driver/integration test    | Not run: SQL Server runtime unavailable. Expanded executable test supplied for Docker/CI                                                                                               |
| Complete stack smoke                            | Not run: requires Docker and SQL Server                                                                                                                                                |
| Native Android/iOS binaries/device UI           | Not built or executed; EAS profiles supplied                                                                                                                                           |
| GitHub Actions                                  | Workflow supplied and improved; not executed on GitHub                                                                                                                                 |

The local legacy runtime was PHP 8.3.6, GnuCOBOL 3.1.2, and MariaDB 10.11.14. Compose targets PHP 8.3 on Debian, the distro GnuCOBOL package, MariaDB 11.4, and SQL Server 2022 Developer. The legacy checks establish real behavior across PHP, SQL-backed intake, fixed-width files, and COBOL. Container-specific behavior still belongs to the Docker gate.

The TypeScript tests use a fake Store boundary. They prove request/role/recovery/comparison logic in isolation; they do not prove Microsoft SQL Server syntax, locks, migrations, or transaction correctness. The supplied SQL integration test now covers atomic request/outbox creation, replay/conflict, exclusive/stale leases, final-status preservation, source-sequence ordering for account projections, and persisted reconciliation findings. Those assertions are not yet runtime evidence.

Platform bundle exports establish compilation. Native configuration introspection establishes generated policy values. Neither proves a signed binary, device networking, native sharing, or UI behavior on an actual phone.

## Remaining acceptance gate

Use a Docker-capable machine with a disposable fresh database/core and the worker stopped:

```powershell
node scripts/setup.mjs
npm ci
docker compose up --build -d --wait api
docker compose exec -T legacy php /app/tests/legacy_integration.php
docker compose exec -T api npm run test:legacy-http --workspace @bureau/server
docker compose exec -T api npm run test:sql --workspace @bureau/server
docker compose up --build -d worker
npm run smoke
```

These tests change local demo data. The SQL test requires an otherwise empty outbox and removes its own rows. On an existing v0.1 environment, use the README upgrade sequence first. Native acceptance then requires a configured Expo/EAS project, Android/iOS builds, and checks of login, retries, balance timestamps, history, reconciliation, and export/share on devices.
