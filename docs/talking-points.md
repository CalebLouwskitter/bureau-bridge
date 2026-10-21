# Talking points

Notes for talking about BureauBridge with interviewers and colleagues. Written in the first person so they can be said as they are. The [demo script](demo-script.md) is the live version.

## The 2-minute pitch

> BureauBridge is a lab I built around a problem banks and payroll bureaus actually have: putting a modern product in front of a ledger you can't rewrite yet.
>
> The story is a South African payroll bureau acquired by a fintech. Operators use a PHP portal. A real GnuCOBOL batch program owns the ledger in indexed files. The new product is a TypeScript API and worker on SQL Server, with an Expo mobile app. The rule I held to is that COBOL stays the only financial authority. SQL Server holds workflow state and read-only projections, never a balance it can change.
>
> The interesting part is the failure between systems. The core commits a batch, then the result file is lost before PHP imports it. Did the money move? A naive retry posts it twice. I made every request carry one immutable reference from the phone to the COBOL journal. The core deduplicates on it, and recovery is an explicit inquiry that reads the journal instead of reposting.
>
> I then added the external leg: paying employees by EFT. The same ambiguity shows up at the bank. You send a file, the response times out, and you don't know whether the bank paid. Payouts are ledger postings into a settlement account in COBOL. Each payout can be in only one file, and the hub asks the bank about a file's generation before it ever resends. Bank returns credit the employee exactly once, keyed by the payout. A reconciliation break report then has to explain every cent in settlement.
>
> All of it runs in Docker. CI runs the real COBOL tests, PHP against MariaDB, SQL Server concurrency tests and a full-stack smoke scenario that loses a batch result and a bank response and recovers both.

**If they only remember one thing:** the same idea solves both edges. Give every movement of money one durable reference, make every receiver deduplicate on it, and when you don't know the outcome, ask; never resend blindly.

## Numbers worth knowing

| | |
| --- | --- |
| Languages | TypeScript, PHP, COBOL, Python, T-SQL, plus Expo/React Native |
| Services in Compose | 8: MariaDB, SQL Server, legacy PHP+COBOL, scheduler, SQL migration job, API, worker, demo bank |
| Batch record | 75 bytes in, 139 bytes out; EFT records are 80 bytes |
| Demo fixture | R100,000 prefund (10,000,000 cents), conserved across all accounts |
| Limits | R50,000 per transfer, 100 requests per batch, 500 payouts per file, 5,000 records per reconciliation scan |
| Retries | Exponential backoff, `NEEDS_REVIEW` after 6 consecutive failures |
| Tests | 23 TypeScript tests, 9 real COBOL tests, PHP+MariaDB+COBOL integration, SQL Server integration, full-stack smoke, all in CI |

## The three hardest problems

### 1. Outcomes you can't know across a boundary with no shared transaction

SQL Server, PHP/MariaDB, the COBOL files and the bank can't share one transaction. Any hop can succeed while its acknowledgement is lost.

**What I did**
- The API writes the request and its outbox row in one SQL transaction. A client idempotency key replays the same request; reusing it with a different payload is a 409.
- The reference never changes. The worker looks the reference up in PHP before submitting, so a lost acknowledgement doesn't create a second intake.
- The COBOL journal records every terminal outcome under that reference. Identical replay returns the original result; a changed payload under the same reference is a `CONFLICT`.
- For the bank, the hub asks for the response to a file's generation before sending. If that question itself fails, it doesn't send.

**Trade-offs I took**
- Recovery is explicit: an operator runs inquiry or verify-and-resume. Nothing reposts automatically. That's slower but auditable, and an automatic repost is exactly the bug I'm trying to prevent.
- Ambiguous states (`VERIFYING`, `SUBMISSION_UNKNOWN`) are visible to users. That's honest, but it's more for the UI and support to explain.

### 2. One financial authority while two systems run side by side

During a migration it's tempting to copy balances into the new database "for performance". Then you have two ledgers that will disagree.

**What I did**
- COBOL owns balances. SQL Server holds projections stamped with the core generation, commit time and a monotonic sequence; a stale snapshot can't overwrite a newer one.
- The core publishes account and journal files together: it copies the indexed files to a private generation, runs COBOL, checks results and value conservation, fsyncs, then swaps one symlink atomically. A crash before the swap leaves the old ledger; a crash after it is resolved from the journal.
- Payouts didn't get a shortcut. They're postings into a settlement account inside COBOL, through the same intake, batch and journal, so they inherit all the replay protection.

**Trade-offs I took**
- The product inherits batch latency. A payout needs one batch for its debit, and a return needs another for its credit.
- The core is a single writer on a local Linux filesystem. That's honest for the mock, but it doesn't scale out.
- Settlement accumulates paid-out value so the fixed-total conservation check still works. A real ledger would clear it daily against the bank statement.

### 3. Paying out exactly once: idempotent files and returns

Bank files are where double payment really happens: a re-run job, a resend after a timeout, a returns file processed twice.

**What I did**
- One reference per payout: the instruction Id is the core debit Id and the payment reference in the file.
- File generation takes a per-client range lock, claims debited and unfiled payouts, and writes the file and the claims in one transaction. A payout can be in only one file. Replaying the request key returns the same file.
- File bytes are deterministic, parsed back before storing and kept with a SHA-256, so a resend is byte-identical. The trailer carries a count, an amount total and an account-number hash total. The hash total catches a redirected account even when the amounts still add up.
- Each bank response is processed once per file. A return creates a credit whose idempotency key is a UUID derived from the payout Id, so the same return can't credit twice even through a different path. The core journal is the second layer.
- The break report must explain every cent in settlement and flags any settlement posting without a payout instruction.

**Trade-offs I took**
- File generation is serialized per client. That's fine for payroll volumes, and I'd partition it if it ever mattered.
- The demo bank sends returns in the same response. Real returns arrive over days in separate files, so production needs a returns-file importer keyed the same way.
- A rejected file releases its payouts for a new file. That's correct when nothing was paid, but it needs an operator to understand why the bank rejected it.

## What I'd do in production

- **Real formats and transport.** Use the bank's actual specification, or ISO 20022 `pain.001` for payments and `camt.054`/`camt.053` for notifications and statements, over host-to-host SFTP with PGP signing and encryption. Handle the bank's acknowledgement, response and returns files as separate stages.
- **Validate before filing.** Run bank-specific check-digit validation on account numbers. Use the bank's account verification service so a payout goes to the person it names.
- **Clear settlement daily.** Match settlement movements to the bank statement and investigate breaks with ageing, owners and sign-off.
- **Controls.** Maker-checker approval on payout files above a threshold, segregation of duties between requesting and releasing, and an append-only, tamper-evident audit trail.
- **Calendars and cut-offs.** Business-day and public-holiday calendars for action dates, plus bank cut-off times. Same-day and real-time rails such as RTC and PayShap shrink the ambiguity window but don't remove the need for inquiry.
- **Identity and secrets.** An OIDC identity provider in place of demo users. Secrets in a vault or HSM, rotated, never in `.env`.
- **POPIA.** Bank details are personal information: encrypt at rest, mask in logs and UIs, limit retention, and log access.
- **Observability.** One correlation ID carried API → outbox → PHP → batch manifest → core generation → bank file. Alerts on `VERIFYING` age, `SUBMISSION_UNKNOWN`, `NEEDS_REVIEW` and reconciliation `HIGH` findings.
- **Operations.** Backups and restore drills for core generations, generation pruning, and DR. Load tests to find the real batch and file limits.
- **Scale.** Replace the single-writer core with a partitioned ledger service. Use CDC instead of a polled outbox, and pick a broker with at-least-once delivery and consumer-side deduplication.

## Likely questions, with answers

**Why not just retry when the batch result or bank response is lost?**
Because a lost response doesn't mean the work didn't happen. A blind retry turns one ambiguous outcome into a possible double posting or double payment. I ask the system of record (the COBOL journal, or the bank for that generation), then act on what it says. If I can't get an answer, I stop and surface it.

**How do you guarantee a payout isn't paid twice?**
There are layers. Each one would be enough on its own in most cases, and together they cover the gaps. The SQL idempotency key stops a second instruction. A payout gets a file only through a claim under a lock, so it can't be in two files. Resends are byte-identical and the hub asks before resending. The bank refuses a reused generation. The break report would show any settlement movement that doesn't belong to an instruction.

**What does idempotent mean here, concretely?**
Doing it again has no further effect and returns the same answer. A replayed API call returns the same allocation, payout or file. Replaying a batch row returns the journal's original outcome. Re-importing a bank response says `duplicate: true` and changes nothing.

**Why keep COBOL at all?**
That's the situation the project models. The core holds tested business rules and is the legal record. Rewriting it and switching in one go is the riskiest option. Strangling it means putting modern interfaces around it and moving responsibilities one at a time. That keeps one source of truth during the transition.

**Why is the settlement account in COBOL instead of SQL Server?**
Because a payout changes a balance, and only the ledger changes balances. If SQL Server tracked paid-out money itself, I'd have two ledgers to reconcile forever. Putting settlement in the core also means the existing conservation check covers payouts for free.

**Why integers for money?**
Floating point can't represent most decimal cents exactly, and rounding errors accumulate. Every layer uses integer cents (`amountMinor`), and the client parser rejects fractions and invalid separators before anything is sent.

**What's the point of reconciliation if every write is already checked?**
Write-time checks enforce rules inside one system. Reconciliation compares independent records across systems, so it catches what no single system can see. Examples: a result imported in one place but not another, a batch whose membership doesn't match its manifest, money in settlement that no payout explains. It reports findings; it never "fixes" money automatically.

**Two operators click "generate file" at the same moment. What happens?**
The per-client range lock serializes them. With the same idempotency key, the second gets the first's file. With different keys, the second finds nothing left to claim and gets a 409. The SQL integration test runs concurrent generation against real SQL Server.

**Why does the file have a hash total of account numbers?**
The amount total proves the amounts weren't changed. A redirected payment can keep the same amount and just change the destination account, and the account-number hash total catches that. There's a test that changes only an account number and expects the trailer check to fail.

**What would break first at 10x volume?**
The single-writer core and the batch size of 100. After that, file generation serialized per client and reconciliation's 5,000-record scan limit. Those limits are explicit, and the scan reports itself incomplete instead of claiming a clean match.

**What did CI catch that local testing didn't?**
The first real SQL Server run showed that after a duplicate-key error, the batch carried on and later foreign-key errors hid the real cause. `SET XACT_ABORT ON` fixed it, and the concurrency test now passes. In this payout slice, CI caught an older core test that assumed the first account in a snapshot was Employee 1; the new settlement account sorts first.

**How did you test without production systems?**
At several levels. Unit tests use a fake store at the persistence boundary. The COBOL suite runs the real compiler and the Python runner with injected faults before and after publication. PHP runs against real MariaDB. The store runs against real SQL Server. A smoke test drives the whole Docker stack, including a lost batch result and a lost bank response. The validation doc separates what was compiled, what was isolated, and what actually ran.

**What would you change if you started again?**
I'd add a correlation ID through every layer from day one; it would have made debugging the cross-language paths faster. I'd also model bank returns as their own file type from the start rather than inside the response.

**What's not done?**
Native Android and iOS builds on devices, real identity, production bank formats and transport, backup and restore, and clearing settlement against statements. The README and validation record say so explicitly.
