<?php
declare(strict_types=1);
require getenv('LEGACY_LIB') ?: (is_file(__DIR__.'/../legacy/php/lib.php') ? __DIR__.'/../legacy/php/lib.php' : __DIR__.'/../php/lib.php');
function check(bool $condition,string $message): void { if (!$condition) throw new RuntimeException($message); }
function sample(): array { return ['reference'=>uuid(),'sourceAccount'=>'INS000000001','targetAccount'=>'EMP000000001','amountMinor'=>25000,'currency'=>'ZAR']; }
$first=sample();
check(intake($first)['status']==='RECEIVED','Intake failed');
check(intake($first)['reference']===$first['reference'],'Replay must preserve reference');
try { intake([...$first,'amountMinor'=>26000]); throw new RuntimeException('Conflict was accepted'); }
catch (DomainException $e) { /* Expected conflict. */ }
batch();
check(lookup($first['reference'])['status']==='POSTED','Batch did not post');
check(inquiry($first['reference'])['coreOutcome']==='POSTED','Inquiry lost committed outcome');
echo "PASS intake, idempotent replay, conflicting payload and normal batch\n";

$second=sample();intake($second);
try {batch(true);throw new LogicException('Fault was not injected');} catch(RuntimeException $e) {}
check(lookup($second['reference'])['status']==='VERIFYING','Missing output must require inquiry');
check(inquiry($second['reference'])['coreOutcome']==='POSTED','Lost output recovery failed');
check(retry_unposted($second['reference'])['status']==='POSTED','Committed request was wrongly requeued');
$batchId=lookup($second['reference'])['batch_id'];
$q=db()->prepare('SELECT status FROM batch_runs WHERE id=?');$q->execute([$batchId]);
check($q->fetchColumn()==='RECONCILED','Batch reconciliation failed');
echo "PASS lost result, authoritative inquiry and reconciled batch\n";

$third=sample();intake($third);
db()->prepare("UPDATE requests SET status='VERIFYING' WHERE reference=?")->execute([$third['reference']]);
check(inquiry($third['reference'])['coreOutcome']==='NOTFOUND','Unposted request unexpectedly exists');
check(retry_unposted($third['reference'])['status']==='RECEIVED','Unposted recovery did not requeue');
batch();check(lookup($third['reference'])['status']==='POSTED','Recovered request did not post');
echo "PASS verified unposted recovery\n";

$suspended=[...sample(),'targetAccount'=>'EMP000000003'];intake($suspended);batch();
check(lookup($suspended['reference'])['reason']==='TARGET_SUSPENDED','Suspended target was not declined by core');
$snapshot=core_run('SNAPSHOT');$inventory=reconciliation_inventory();
check($snapshot['generation']===$inventory['core']['generation'],'Read snapshots differ without a posting');
check(count(array_filter($inventory['core']['records'],fn($r)=>$r['reference']===$second['reference']))===1,'Core audit lost a recovered reference');
foreach (batch_controls() as $b) {
    check($b['control_match'],'Batch membership totals differ from its manifest');
    check($b['submitted_count']===$b['posted_count']+$b['declined_count']+$b['unresolved_count'],'Batch result counts do not reconcile');
}
check(str_contains(csv_text(['details'],[['=1+1']]),"'=1+1"),'CSV formula escaping missing');
$final=lookup($first['reference']);
try {
    import_result(['records'=>[[...$inventory['core']['records'][0], 'reference'=>$first['reference'],
        'sourceAccount'=>$first['sourceAccount'],'targetAccount'=>$first['targetAccount'],'amountMinor'=>$first['amountMinor'],
        'currency'=>'ZAR','status'=>'POSTED','reason'=>'OK','postingId'=>uuid()]]]);
    throw new LogicException('Changed terminal posting ID was accepted');
} catch (RuntimeException $e) { check(lookup($first['reference'])['posting_id']===$final['posting_id'],'Final posting reference changed'); }
echo "PASS suspended account, read-only inventory, batch controls, CSV escaping and immutable final outcome\n";
