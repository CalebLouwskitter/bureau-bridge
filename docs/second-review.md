# BureauBridge — second requirements review

**Reviewed:** 30 September 2026 · **Corrected source:** v0.2.0

**Finding:** v0.1 did not meet every proposed idea. v0.2 fills the missing balance/reconciliation/reporting views and corrects recovery, authentication, and mobile setup issues. The confirmed foundation is represented in the code. Subsequent [GitHub CI execution](https://github.com/CalebLouwskitter/bureau-bridge/actions/runs/36699107346) verified Microsoft SQL Server and the complete Docker smoke scenario; native mobile builds/device checks remain pending.

## Requirement coverage

| Requirement or agreed idea                         | Current implementation and evidence                                                                                                             | Status                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Payroll bureau acquired by fintech; insurer client | One fictional South African insurer payroll fixture; documented business situation                                                              | Met                                                                                      |
| PHP portal with relational intake data             | Real PHP forms/JSON, MariaDB requests/manifests/membership/inquiries; integration and HTTP checks pass                                          | Met in local runtime                                                                     |
| COBOL indexed authoritative core                   | Executable GnuCOBOL account/journal files, internal allocation rules, active/suspended state, R50,000 per-transfer limit                        | Met in local runtime                                                                     |
| Legacy-to-modern integration using TypeScript      | Fastify API, worker, shared typed contracts, authenticated PHP boundary and file protocol; TypeScript and real legacy client checks pass        | Met; full-stack CI passed                                                               |
| Microsoft SQL Server                               | Schema, runtime login, transactional outbox, leases, projections, saved reconciliation; migration and driver configured                         | Real SQL integration passed in CI                                                       |
| Several daily batches, end-of-day, operator run    | 08:00/12:00/16:00/23:00 Johannesburg schedule; manual path uses the same exporter/core protocol                                                 | Configured; manual runs verified, clock-triggered execution unobserved                   |
| Internal allocations and honest status wording     | Prefunded client → employee payable; “Posted internally” remains distinct from an external payout                                               | Met                                                                                      |
| Replay protection and lost-result recovery         | Stable references, conflicting-payload rejection, processed journal, atomic generation publication, core inquiry and verified resumption        | Core/PHP/worker checks and real SQL/full-stack CI passed                                 |
| Balance/status/history read views                  | Timestamped core snapshots, role-filtered account API, modern register and history screen; source sequence rejects stale projections            | Snapshot/role/compile and SQL storage checks pass; device views pending                  |
| Reconciliation screen and exported reports         | Scheduled/on-demand comparison; immutable batch membership; PHP batch/request CSVs; ops reconciliation view/CSV; journal-derived balance checks | Comparison, SQL persistence and HTTP/CSV reports verified; native sharing pending        |
| Android/iOS Expo setup                             | Expo Go and dev-client scripts, EAS profiles, local HTTP config, production HTTPS guard                                                         | Android/iOS/web bundles and native config pass; native binaries/devices pending          |
| Mobile retry resilience                            | Immutable request persisted before POST, safe cache parsing, synchronous action guard, session-generation guard for stale responses             | Cache contract tests and platform compilation pass; device interaction pending           |
| Roles and credential boundaries                    | Payroll/employee/ops routes; employee account ownership; separate bridge and operations secrets; operator Basic auth/form token                 | Isolated API and real PHP HTTP checks pass                                               |
| Infrastructure and repeatable verification         | Seven-service Compose, generated local credentials, migration entrypoints, expanded SQL/smoke checks and CI workflow                            | Docker/SQL/full-stack CI passed; scheduled clock behavior unobserved                      |
| PHP refresher and CV learning story                | README explains PHP intake/web role, COBOL ledger authority, TypeScript bridge, and separate databases                                          | Met                                                                                      |

## Defects and omissions corrected

1. **Final outcome could regress.** Inquiry could wake an already completed outbox item, and a later legacy outage could replace `POSTED` with `VERIFYING`. Final jobs now close without contacting legacy; API/SQL wake paths exclude final requests; SQL finish/retry updates preserve final outcomes. PHP imports lock each request and reject a changed final outcome/posting reference.
2. **Promised balances and reconciliation were absent.** Added read-only core account snapshots, journal audit, SQL projections and reconciliation tables, comparison scheduling, ops screens, status history, and CSV endpoints. Comparisons check payloads/outcomes, missing references, pending imports, batch controls, and seed-plus-journal balances. Incomplete scans are explicitly flagged at the 5000-record limit.
3. **Batch membership could be overwritten during recovery.** Each export now keeps its own membership rows, preserving original counts/amounts when a reference is requeued later. Batch reports show submitted, posted, declined, and unresolved counts/totals.
4. **Account activity was only an idea.** The core now enforces active/suspended state using the existing record layout. A suspended employee fixture demonstrates a real core decline. A tested generation upgrade preserves v0.1 account balances and journal history while adding that zero-value fixture.
5. **Demo auth accepted inherited object names.** User lookup now requires an own property; `toString`, `constructor`, and `__proto__` do not receive sessions.
6. **Mobile setup/retry handling needed safeguards.** Expo Go is selected explicitly; native lab builds allow local HTTP while production requires HTTPS. Damaged saved requests no longer block sign-in. Actions use an immediate lock, and responses from an old session cannot refill the next session's register.
7. **CI and docs overstated coverage.** PHP lint now fails the job on an error; real legacy integration/HTTP checks run before SQL/smoke checks. Docs distinguish actual COBOL fields from surrounding manifests, static demo catalogs from database tables, and implemented features from unrun runtime gates.
8. **Real SQL concurrency exposed a hidden duplicate-key error.** During GitHub validation, later inserts continued after a duplicate allocation was rejected and produced foreign-key errors. The create batch now aborts on the first SQL runtime error; the same concurrent replay/conflict test passed in the successful CI run.

## Evidence from this check

- TypeScript compilation passed.
- **14** API/worker/contracts/reconciliation tests and **7** actual COBOL tests passed.
- All **6** PHP syntax checks passed.
- Real PHP–MariaDB–COBOL integration and TypeScript-to-PHP HTTP checks passed, including CSV authorization and operator session/form-token behavior.
- Web, Android, and iOS bundle exports passed; development/production native network-policy introspection passed.
- Current Compose configuration passed with Compose 2.40.3; full container startup is a separate remaining gate.

## Remaining work and scope limits

Microsoft SQL Server migration/driver/transactions, Docker image startup, and the complete-stack smoke script subsequently passed in GitHub CI. Native signing/builds, phone networking, UI interactions, and export/share still need device checks. Clock-triggered batch execution and an existing-volume Docker/SQL Server upgrade remain unobserved; the indexed-file core upgrade fixture passed.

The lab uses one employer fixture and static demo users. General employer/operator catalog management, bulk payroll uploads, production identity/deployment, backup/restore and retention automation, distributed core writers, and external bank payouts remain future slices. The confirmed first workflow remains internal allocations. Reconciliation observations may overlap imports and do not automatically repost money. Old batch membership already overwritten in v0.1 cannot be reconstructed by this update; mismatched controls remain visible.

The project is suitable for a CV demonstration of legacy modernization, with real SQL Server and complete-stack runtime evidence. Describe the verified scenarios accurately and retain the remaining device, scheduler, and upgrade boundaries.
