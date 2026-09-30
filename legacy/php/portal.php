<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BureauBridge · legacy operations</title>
<style>body{font:15px system-ui;background:#e7e9e7;color:#172b2b;margin:0}header{background:#183a3a;color:white;padding:24px 5%}main{max-width:1100px;margin:28px auto;padding:0 20px}section{background:white;border:1px solid #bbc9c5;padding:24px;margin-bottom:20px}h1{margin:0;font-size:24px}small{color:#c1ded6}label{display:inline-block;margin:0 18px 12px 0}input,select,button{padding:9px;border:1px solid #94aca3}button{background:#234f48;color:white;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:12px 8px;border-bottom:1px solid #d9e2de;text-align:left}code{font-size:11px} .scroll{overflow:auto}.notice{color:#234f48}</style>
<header><small>PAYROLL BUREAU / INTERNAL OPERATIONS</small><h1>BureauBridge legacy portal</h1></header><main>
<p>Fictional insurer payroll · internal allocations · results appear after a batch import.</p>
<?php if ($notice): ?><p class="notice"><?=h($notice)?></p><?php endif ?>
<section><h2>Enter allocation</h2><form method="post"><input type="hidden" name="csrf" value="<?=h($_SESSION['csrf'])?>">
<label>Employee <select name="targetAccount"><option>EMP000000001</option><option>EMP000000002</option><option value="EMP000000003">EMP000000003 · suspended</option></select></label>
<label>Amount in cents <input type="number" name="amountMinor" value="25000" min="1" max="999999999999" required></label>
<button>Receive request</button></form></section>
<section><form method="post"><input type="hidden" name="csrf" value="<?=h($_SESSION['csrf'])?>"><button name="run" value="1">Run pending batch</button></form></section>
<section class="scroll"><h2>Request register</h2><p><a href="/reports/requests.csv">Export request CSV</a></p><table><thead><tr><th>Reference</th><th>Employee</th><th>Rand</th><th>Status</th><th>Reason</th><th>Recovery</th></tr></thead><tbody>
<?php foreach ($rows as $row): ?><tr><td><code><?=h($row['reference'])?></code></td><td><?=h($row['target_account'])?></td><td>R<?=h(number_format((int)$row['amount_minor']/100,2))?></td><td><?=h($row['status'])?></td><td><?=h($row['reason'])?></td><td><form method="post"><input type="hidden" name="csrf" value="<?=h($_SESSION['csrf'])?>"><button name="inquire" value="<?=h($row['reference'])?>">Core inquiry</button></form></td></tr><?php endforeach ?>
</tbody></table></section>
<section class="scroll"><h2>Batch controls</h2><p><a href="/reports/batches.csv">Export batch CSV</a> · amounts below are integer cents; latest 50 batches.</p>
<table><thead><tr><th>Batch</th><th>Status</th><th>Expected count / cents</th><th>Exported count / cents</th><th>Posted count / cents</th><th>Declined count / cents</th><th>Unresolved</th><th>Control match</th></tr></thead><tbody>
<?php foreach ($batches as $b): ?><tr><td><code><?=h($b['id'])?></code></td><td><?=h($b['status'])?></td>
<td><?=h($b['record_count'])?> / <?=h($b['amount_total'])?></td><td><?=h($b['submitted_count'])?> / <?=h($b['submitted_total'])?></td>
<td><?=h($b['posted_count'])?> / <?=h($b['posted_total'])?></td><td><?=h($b['declined_count'])?> / <?=h($b['declined_total'])?></td>
<td><?=h($b['unresolved_count'])?></td><td><?=h($b['control_match']?'MATCH':'INVESTIGATE')?></td></tr><?php endforeach ?>
</tbody></table></section></main></html>
