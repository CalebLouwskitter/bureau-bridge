# Validation evidence — v0.2

The local second review was performed on 30 September 2026. The project was subsequently published to GitHub and validated there; no application deployment was created.

## Soft fintech mobile slice — 5 October 2026

The Expo redesign is developed on `feature/mobile-soft-fintech` in focused commits with `[skip ci]`, as requested. This slice was validated locally; it has no new GitHub CI result.

| Check | Result |
| --- | --- |
| TypeScript | Server and mobile checks passed |
| Existing API/worker/contracts/reconciliation tests | 14 passed |
| Browser interaction checks | 5 passed against the exported Expo app and an isolated fictional API fixture |
| Browser scenarios | Light default with a dark OS preference; saved black/mint and light choices; masked/showable password; retry with the same UUID and integer-cent payload after restart; decimal comma entry and invalid grouping rejection; employee views/history; operations inquiry/resumption/comparison/CSV download |
| Narrow layout | 320-pixel layout checked across operations tabs, including dark mode, visible 44-point tab targets and no JavaScript runtime errors |
| Platform exports | Web JavaScript and Android/iOS Hermes bundles exported successfully |
| Visual review | Light and black/mint dashboard captures inspected; documented in [the mobile design guide](mobile-design.md) |

The browser checks establish client behaviour at a mocked HTTP boundary. The separate server suite covers API roles and ownership. Android/iOS binaries, device networking, keyboards, native sharing, and screen-reader behaviour on phones still need device acceptance. The historical real Docker/SQL Server evidence below remains attached to its original commit and run.

## GitHub runtime verification

[GitHub Actions run 36699107346](https://github.com/CalebLouwskitter/bureau-bridge/actions/runs/36699107346) passed on 30 September 2026 against [code commit 4c336af](https://github.com/CalebLouwskitter/bureau-bridge/commit/4c336af8be8bb20eee3d95d07699051a1601556e). It verified:

- TypeScript checks, 14 API/worker/contracts/reconciliation tests, 7 real COBOL tests, and PHP syntax checks.
- Docker image builds and startup of the API, legacy service, both databases, migration job, and worker.
- Real PHP/MariaDB/COBOL integration and the authenticated TypeScript-to-PHP HTTP boundary.
- SQL Server migrations, concurrent atomic create/replay/conflict, exclusive and stale leases, immutable final outcomes, stale account snapshot rejection, and persisted reconciliation.
- Complete-stack smoke: normal posting, a lost result after core commit, inquiry recovery, suspended-account decline, private balances, reconciliation, and CSV reports.

The first CI run exposed a duplicate-request bug: SQL Server continued later statements after the allocation insert failed, so foreign-key errors hid the duplicate-key error. The create batch now enables `XACT_ABORT`; the same real SQL concurrency test passed in the successful run.

This closes the original Docker/SQL Server acceptance gate. Signed Android/iOS binaries and device behavior, clock-triggered batch execution, and an existing-volume Docker/SQL Server upgrade remain unverified. The COBOL indexed-file upgrade fixture passed.

## Local second-review evidence

The table below records the earlier local environment. The Docker/SQL Server checks that were unrun locally were later completed by the GitHub run above.

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

The TypeScript unit tests use a fake Store boundary. They prove request/role/recovery/comparison logic in isolation. The separate SQL integration test covers atomic request/outbox creation, replay/conflict, exclusive/stale leases, final-status preservation, source-sequence ordering for account projections, and persisted reconciliation findings; it now has real runtime evidence from GitHub CI.

Platform bundle exports establish compilation. Native configuration introspection establishes generated policy values. Neither proves a signed binary, device networking, native sharing, or UI behavior on an actual phone.

## Remaining acceptance gate

Native device acceptance remains pending. To reproduce the completed server acceptance gate, use a Docker-capable machine with a disposable fresh database/core and the worker stopped:

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
