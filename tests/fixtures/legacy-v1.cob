       >>SOURCE FORMAT FREE
identification division.
program-id. legacy-v1-fixture.
environment division.
input-output section.
file-control.
    select accounts assign to "accounts.idx"
        organization indexed access dynamic record key account-id.
    select journal assign to "journal.idx"
        organization indexed access dynamic record key journal-ref.
    select balances assign to "balances.dat" organization line sequential.
data division.
file section.
fd accounts.
01 account-row.
   02 account-id pic x(12).
   02 account-cents pic 9(12).
   02 account-kind pic x.
fd journal.
01 journal-row.
   02 journal-ref pic x(36).
   02 journal-source pic x(12).
   02 journal-target pic x(12).
   02 journal-cents pic 9(12).
   02 journal-currency pic x(3).
   02 journal-status pic x(8).
   02 journal-reason pic x(20).
   02 journal-posting pic x(36).
fd balances.
01 balance-row pic x(25).
procedure division.
    open output accounts journal balances
    move "INS000000001" to account-id
    move 9975000 to account-cents
    move "C" to account-kind
    write account-row
    move account-row to balance-row
    write balance-row
    move "EMP000000001" to account-id
    move 25000 to account-cents
    move "E" to account-kind
    write account-row
    move account-row to balance-row
    write balance-row
    move "EMP000000002" to account-id
    move 0 to account-cents
    write account-row
    move account-row to balance-row
    write balance-row
    move "00000000-0000-4000-8000-000000000001" to journal-ref
    move journal-ref to journal-posting
    move "INS000000001" to journal-source
    move "EMP000000001" to journal-target
    move 25000 to journal-cents
    move "ZAR" to journal-currency
    move "POSTED" to journal-status
    move "OK" to journal-reason
    write journal-row
    close accounts journal balances
    stop run.
