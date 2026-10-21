       >>SOURCE FORMAT FREE
identification division.
program-id. payroll-core.
environment division.
input-output section.
file-control.
    select accounts assign to "accounts.idx"
        organization indexed access dynamic
        record key account-id file status account-fs.
    select journal assign to "journal.idx"
        organization indexed access dynamic
        record key journal-ref file status journal-fs.
    select requests assign to "input.dat"
        organization line sequential file status input-fs.
    select results assign to "output.dat"
        organization line sequential file status output-fs.
    select balances assign to "balances.dat"
        organization line sequential.
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
fd requests.
01 input-row.
   02 input-ref pic x(36).
   02 input-source pic x(12).
   02 input-target pic x(12).
   02 input-cents pic 9(12).
   02 input-currency pic x(3).
fd results.
01 output-row pic x(139).
fd balances.
01 balance-row pic x(25).
working-storage section.
01 account-fs pic xx.
01 journal-fs pic xx.
01 input-fs pic xx.
01 output-fs pic xx.
01 run-mode pic x(10).
01 eof-flag pic 9 value 0.
01 source-before pic 9(12).
01 target-before pic 9(12).
01 decision pic x(8).
01 reason-code pic x(20).
01 transfer-kind pic x(10).
01 route-ok pic x.
procedure division.
main.
    accept run-mode from environment "CORE_MODE"
    if run-mode = "SEED"
        open output accounts journal
        perform check-files
        move "INS000000001" to account-id
        move 10000000 to account-cents
        move "C" to account-kind
        write account-row
        move "EMP000000001" to account-id
        move 0 to account-cents
        move "E" to account-kind
        write account-row
        move "EMP000000002" to account-id
        write account-row
        move "EMP000000003" to account-id
        move "e" to account-kind
        write account-row
        move "BNK000000001" to account-id
        move "S" to account-kind
        write account-row
        close accounts journal
    else
        open i-o accounts journal
        perform check-files
        if run-mode = "UPGRADE"
            perform ensure-suspended-account
            perform ensure-settlement-account
        else
        open output results
        if output-fs not = "00" stop run returning 70 end-if
        if run-mode = "AUDIT"
            perform until eof-flag = 1
                read journal next record
                evaluate journal-fs
                    when "10" move 1 to eof-flag
                    when "00" move journal-row to output-row
                              write output-row
                              if output-fs not = "00"
                                  stop run returning 70
                              end-if
                    when other stop run returning 70
                end-evaluate
            end-perform
        else
            open input requests
            if input-fs not = "00" stop run returning 70 end-if
            perform until eof-flag = 1
                read requests
                evaluate input-fs
                    when "10" move 1 to eof-flag
                    when "00" perform process-row
                    when other stop run returning 70
                end-evaluate
            end-perform
            close requests
        end-if
        close results
        end-if
        close accounts journal
    end-if
    open input accounts
    open output balances
    move 0 to eof-flag
    perform until eof-flag = 1
        read accounts next record
        evaluate account-fs
            when "10" move 1 to eof-flag
            when "00" move account-row to balance-row
                      write balance-row
            when other stop run returning 70
        end-evaluate
    end-perform
    close accounts balances
    stop run returning 0.
check-files.
    if account-fs not = "00" or journal-fs not = "00"
        stop run returning 70
    end-if.
ensure-suspended-account.
    move "EMP000000003" to account-id
    read accounts
    evaluate account-fs
        when "23"
            move 0 to account-cents
            move "e" to account-kind
            write account-row
            if account-fs not = "00" stop run returning 70 end-if
        when "00" continue
        when other stop run returning 70
    end-evaluate.
ensure-settlement-account.
    move "BNK000000001" to account-id
    read accounts
    evaluate account-fs
        when "23"
            move 0 to account-cents
            move "S" to account-kind
            write account-row
            if account-fs not = "00" stop run returning 70 end-if
        when "00" continue
        when other stop run returning 70
    end-evaluate.
process-row.
    move input-ref to journal-ref
    read journal
    evaluate journal-fs
        when "00"
            if run-mode = "POST" and
               (journal-source not = input-source or
                journal-target not = input-target or
                journal-cents not = input-cents or
                journal-currency not = input-currency)
                move "CONFLICT" to journal-status
                move "REFERENCE_REUSED" to journal-reason
                move spaces to journal-posting
            end-if
        when "23"
            move input-row to journal-row(1:75)
            move spaces to journal-posting
            if run-mode = "QUERY"
                move "NOTFOUND" to journal-status
                move "REFERENCE_UNKNOWN" to journal-reason
            else
                perform new-transfer
            end-if
        when other stop run returning 70
    end-evaluate
    move journal-row to output-row
    write output-row
    if output-fs not = "00" stop run returning 70 end-if.
*> The source account type selects the route: client to employee is an
*> allocation, employee to settlement is a bank payout, and settlement to
*> employee credits back a payout the bank returned.
new-transfer.
    move "DECLINED" to decision
    move "INVALID_REQUEST" to reason-code
    move spaces to transfer-kind
    if input-cents is numeric and input-cents > 0
       and input-currency = "ZAR" and input-source not = input-target
        move input-source to account-id
        read accounts
        evaluate account-fs
            when "23" move "SOURCE_UNKNOWN" to reason-code
            when "00"
                move account-cents to source-before
                evaluate account-kind
                    when "C" move "ALLOCATION" to transfer-kind
                    when "E" move "PAYOUT" to transfer-kind
                    when "S" move "RETURN" to transfer-kind
                    when "c" move "SOURCE_SUSPENDED" to reason-code
                    when "e" move "SOURCE_SUSPENDED" to reason-code
                    when "s" move "SOURCE_SUSPENDED" to reason-code
                    when other move "ROUTE_NOT_ALLOWED" to reason-code
                end-evaluate
                if transfer-kind not = spaces
                    perform check-target
                end-if
            when other stop run returning 70
        end-evaluate
    end-if
    move input-row to journal-row(1:75)
    move decision to journal-status
    move reason-code to journal-reason
    move spaces to journal-posting
    if decision = "POSTED" move input-ref to journal-posting end-if
    write journal-row
    if journal-fs not = "00" stop run returning 70 end-if.
check-target.
    move input-target to account-id
    read accounts
    evaluate account-fs
        when "23" move "TARGET_UNKNOWN" to reason-code
        when "00"
            perform check-route
            evaluate true
                when transfer-kind = "ALLOCATION" and account-kind = "e"
                    move "TARGET_SUSPENDED" to reason-code
                when route-ok not = "Y"
                    move "ROUTE_NOT_ALLOWED" to reason-code
                when input-cents > source-before
                    move "INSUFFICIENT_FUNDS" to reason-code
                when input-cents > 5000000 and transfer-kind not = "RETURN"
                    move "PER_TRANSFER_LIMIT" to reason-code
                when other
                    move account-cents to target-before
                    if target-before + input-cents > 999999999999
                        move "BALANCE_OVERFLOW" to reason-code
                    else
                        perform post-transfer
                    end-if
            end-evaluate
        when other stop run returning 70
    end-evaluate.
*> A return must credit the employee even if the payable was suspended after
*> the payout left; the limit check above also exempts returns.
check-route.
    move "N" to route-ok
    if transfer-kind = "ALLOCATION" and account-kind = "E"
        move "Y" to route-ok
    end-if
    if transfer-kind = "PAYOUT" and account-kind = "S"
        move "Y" to route-ok
    end-if
    if transfer-kind = "RETURN" and (account-kind = "E" or account-kind = "e")
        move "Y" to route-ok
    end-if.
post-transfer.
    move input-source to account-id
    read accounts
    if account-fs not = "00" stop run returning 70 end-if
    compute account-cents = source-before - input-cents
    rewrite account-row
    if account-fs not = "00" stop run returning 70 end-if
    move input-target to account-id
    read accounts
    if account-fs not = "00" stop run returning 70 end-if
    compute account-cents = target-before + input-cents
    rewrite account-row
    if account-fs not = "00" stop run returning 70 end-if
    move "POSTED" to decision
    move "OK" to reason-code.
