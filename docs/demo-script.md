# Guided demo script

About 10 minutes. It shows the original recovery story, then the payout leg. Run it on a fresh lab so the numbers are clean. The [talking points](talking-points.md) cover the questions that usually follow.

## Before the meeting

```powershell
node scripts/setup.mjs
npm ci
docker compose up --build -d --wait api worker
npm run web
```

- Keep two terminals open: one for `docker compose exec` batch commands, one for `npm run demo:payouts`.
- Open Expo web (`http://localhost:8081`) and the PHP portal (`http://localhost:8080`, user `operator`). The password is `DEMO_PASSWORD` in your `.env`.
- Optional: `docker compose stop scheduler`, so a timed batch can't run in the middle of the demo.

## 1. Set the scene (1 minute)

Open the [architecture diagram](../README.md#architecture).

> "A payroll bureau, acquired by a fintech. Operators use PHP; a COBOL batch job owns the ledger. I'm adding a TypeScript API, SQL Server and a mobile app without giving up one source of truth."

Point at the arrows: Expo → API → SQL outbox → worker → PHP → fixed-width batch → COBOL → journal.

## 2. A normal allocation (1 minute)

1. In Expo, sign in as `insurer-admin`. Open **Allocate** and send **R250.00** to Employee 1.
2. It shows **Awaiting payroll batch**. Say: "intake is just an acknowledgement; only the core decides the outcome."
3. Run the batch:

   ```powershell
   docker compose exec legacy php /app/php/batch.php
   ```

4. It becomes **Posted internally**. Say: "internally, because the money is still inside the bureau's ledger. Paying it out is the second half of the demo."

## 3. Lose a result and recover it (2 minutes)

1. Send another allocation and wait for **Awaiting payroll batch**.
2. Commit in COBOL, then withhold the result:

   ```powershell
   docker compose exec legacy php /app/php/batch.php --drop-result
   ```

3. It shows **Verifying core outcome**. Ask the room: "Did the money move? Is a retry safe?"
4. Sign in as `ops` → **Activity** → **Run core inquiry**. It goes to **Posted internally** with the same reference.
5. Say: "inquiry reads the COBOL journal. It never posts. If the journal says `NOTFOUND`, a separate verify-and-resume action requeues it under the batch lock."

## 4. Pay out by EFT (4 minutes)

Run the narrated walkthrough. `--step` pauses for Enter after each heading so you can talk:

```powershell
npm run demo:payouts -- --step
```

| Step | What to say |
| --- | --- |
| Fund Employee 2 | "Same allocation path as before, so there's something to pay out." |
| Request two payouts | "A payout is a core debit from the payable into a settlement account. Replaying the same key returns the same instruction." |
| File before the debit posts | "Nothing is ready: money only goes into a bank file after the ledger has debited it." |
| Generate the EFT file | Point at the printed file: header, two details, trailer. "Count, amount total, and a hash total of account numbers. That last one catches a redirected account even when the amounts still match." |
| Lose the bank's answer | "The bank processed it, but we got a 504. The file shows `SUBMISSION_UNKNOWN`." |
| Submit again | "We ask the bank about generation 1 before sending anything. It has it, so we import the original answer. Nothing is sent twice." Point at `duplicate false`, then the re-import showing `duplicate true`. |
| Credit back the return | "Employee 2's account is closed at the bank, so it's returned with code AC. The return is a keyed core credit, posted in the next batch." |
| Reconcile settlement | "Every cent in settlement is explained: what the bank paid, files awaiting a response, debits awaiting a file, returns awaiting credit. No HIGH findings." |

Back in Expo as `ops`, open **Ops** → **Run comparison** to show the same findings, including `SETTLEMENT_SUMMARY`, and export the CSV.

## 5. Close (1 minute)

> "The same principle handles both edges: one durable reference, deduplication at every receiver, and ask before you resend. What I'd do next for production is in the talking points: real bank formats over SFTP, account verification, daily settlement clearing against statements, and maker-checker on payout files."

## If something goes wrong live

| Symptom | Fix |
| --- | --- |
| A step waits at **Awaiting payroll batch** | Run the batch command; the scheduler only runs at 08:00, 12:00, 16:00 and 23:00 |
| `Sign-in failed` | Run from the repo root so `.env` is loaded, and use `DEMO_PASSWORD` from it |
| The bank call fails with 401 | `.env` predates the payout slice; rerun `node scripts/setup.mjs` (it adds `BANK_KEY`) and `docker compose up -d` |
| Settlement summary isn't R0.00 for pending buckets | The lab has data from earlier runs; that's expected. Use `docker compose down -v` before the meeting for a clean slate |
