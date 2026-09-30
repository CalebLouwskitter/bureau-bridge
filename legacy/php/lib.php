<?php
declare(strict_types=1);

function config(string $name, ?string $fallback = null): string {
    $value = getenv($name);
    if ($value === false || $value === '') {
        if ($fallback !== null) return $fallback;
        throw new RuntimeException("Missing configuration: $name");
    }
    return $value;
}
function db(): PDO {
    static $connection;
    if (!$connection) {
      $connection = new PDO(
        'mysql:host=' . config('LEGACY_DB_HOST', 'mariadb') . ';port=' . config('LEGACY_DB_PORT', '3306') .
        ';dbname=' . config('LEGACY_DB_NAME', 'legacy_portal') . ';charset=utf8mb4',
        config('LEGACY_DB_USER', 'legacy'), config('LEGACY_DB_PASSWORD'),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false]);
      $connection->exec("SET time_zone='+00:00'");
    }
    return $connection;
}
function uuid(): string {
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex,0,8).'-'.substr($hex,8,4).'-'.substr($hex,12,4).'-'.substr($hex,16,4).'-'.substr($hex,20);
}
function allocation(array $data): array {
    $ref = $data['reference'] ?? '';
    if (!is_string($ref) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $ref))
        throw new InvalidArgumentException('reference must be a lowercase UUID');
    if (($data['sourceAccount'] ?? '') !== 'INS000000001' ||
        !in_array($data['targetAccount'] ?? '', ['EMP000000001','EMP000000002','EMP000000003'], true))
        throw new InvalidArgumentException('Unsupported demo account');
    $amount = $data['amountMinor'] ?? null;
    if (!is_int($amount) || $amount < 1 || $amount > 999999999999 || ($data['currency'] ?? '') !== 'ZAR')
        throw new InvalidArgumentException('Use positive integer cents and ZAR');
    return ['reference'=>$ref, 'sourceAccount'=>$data['sourceAccount'],
        'targetAccount'=>$data['targetAccount'], 'amountMinor'=>$amount, 'currency'=>'ZAR'];
}
function intake(array $data): array {
    $row = allocation($data);
    $hash = hash('sha256', json_encode($row, JSON_THROW_ON_ERROR));
    try {
        $stmt = db()->prepare('INSERT INTO requests (reference,source_account,target_account,amount_minor,currency,fingerprint) VALUES (?,?,?,?,?,?)');
        $stmt->execute([$row['reference'],$row['sourceAccount'],$row['targetAccount'],$row['amountMinor'],$row['currency'],$hash]);
    } catch (PDOException $e) {
        if (($e->errorInfo[1] ?? 0) !== 1062) throw $e;
        $existing = lookup($row['reference']);
        if (!hash_equals($existing['fingerprint'], $hash)) throw new DomainException('Reference already belongs to different request data');
    }
    return public_row(lookup($row['reference']));
}
function lookup(string $ref): ?array {
    $stmt = db()->prepare('SELECT * FROM requests WHERE reference=?');
    $stmt->execute([$ref]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}
function public_row(array $row): array {
    return ['reference'=>$row['reference'],'sourceAccount'=>$row['source_account'],
        'targetAccount'=>$row['target_account'],'amountMinor'=>(int)$row['amount_minor'],
        'currency'=>$row['currency'],'status'=>$row['status'],'reason'=>$row['reason'],
        'postingId'=>$row['posting_id'],'batchId'=>$row['batch_id'],
        'createdAt'=>str_replace(' ','T',$row['created_at']).'Z',
        'updatedAt'=>str_replace(' ','T',$row['updated_at']).'Z'];
}
function record_line(array $row): string {
    return $row['reference'].$row['source_account'].$row['target_account'].
        str_pad((string)$row['amount_minor'],12,'0',STR_PAD_LEFT).$row['currency']."\n";
}
function durable_write(string $path, string $contents): void {
    $temp = $path.'.'.bin2hex(random_bytes(6)).'.tmp';
    $file = fopen($temp,'xb');
    if (!$file) throw new RuntimeException('Cannot create batch file');
    if (fwrite($file,$contents) !== strlen($contents) || !fflush($file) || !fsync($file))
        throw new RuntimeException('Cannot persist batch file');
    fclose($file);
    if (!rename($temp,$path)) throw new RuntimeException('Cannot publish batch file');
}
function core_run(string $mode, ?string $input = null): array {
    $command = ['python3',config('CORE_RUNNER','/app/core-runner.py'),$mode];
    if ($input !== null) $command[] = $input;
    $process = proc_open($command,
        [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot start core runner');
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    if (proc_close($process) !== 0) { error_log($error); throw new RuntimeException('Core outcome requires verification'); }
    return json_decode($output,true,512,JSON_THROW_ON_ERROR);
}
function import_result(array $result): void {
    db()->beginTransaction();
    try {
        foreach ($result['records'] as $record) {
            $stmt = db()->prepare('SELECT * FROM requests WHERE reference=? FOR UPDATE');
            $stmt->execute([$record['reference']]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row || $row['source_account'] !== $record['sourceAccount'] ||
                $row['target_account'] !== $record['targetAccount'] || (int)$row['amount_minor'] !== $record['amountMinor'] ||
                $row['currency'] !== $record['currency']) throw new RuntimeException('Result differs from request');
            if (!in_array($record['status'],['POSTED','DECLINED','NOTFOUND'],true)) throw new RuntimeException('Unrecognized core result');
            if ($record['status'] === 'NOTFOUND') continue;
            if ($record['status'] === 'POSTED' && $record['postingId'] !== $record['reference'])
                throw new RuntimeException('Invalid posting reference');
            if (in_array($row['status'],['POSTED','DECLINED'],true) &&
                ($row['status'] !== $record['status'] || $row['posting_id'] !== $record['postingId'] || $row['reason'] !== $record['reason']))
                throw new RuntimeException('Terminal outcome changed');
            $stmt = db()->prepare('UPDATE requests SET status=?,reason=?,posting_id=? WHERE reference=?');
            $stmt->execute([$record['status'],$record['reason'],$record['postingId'],$record['reference']]);
        }
        db()->commit();
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
}
function inquiry(string $ref): array {
    $row = lookup($ref);
    if (!$row) throw new OutOfBoundsException('Request not found');
    $dir = config('EXCHANGE_ROOT','/data/exchange');
    if (!is_dir($dir)) mkdir($dir,0770,true);
    $path = $dir.'/inquiry-'.uuid().'.dat';
    durable_write($path,record_line($row));
    $result = core_run('QUERY',$path);
    import_result($result);
    if ($row['batch_id']) reconcile_batch($row['batch_id']);
    $stmt = db()->prepare('INSERT INTO inquiries (id,reference,outcome) VALUES (?,?,?)');
    $stmt->execute([uuid(),$ref,$result['records'][0]['status']]);
    return ['request'=>public_row(lookup($ref)),'coreOutcome'=>$result['records'][0]['status']];
}
function reconcile_batch(string $id): void {
    $stmt=db()->prepare("UPDATE batch_runs b SET status='RECONCILED' WHERE id=?
        AND record_count=(SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id)
        AND amount_total=(SELECT COALESCE(SUM(amount_minor),0) FROM batch_items WHERE batch_id=b.id)
        AND NOT EXISTS (SELECT 1 FROM batch_items i JOIN requests r ON r.reference=i.reference
            WHERE i.batch_id=? AND r.status NOT IN ('POSTED','DECLINED'))");
    $stmt->execute([$id,$id]);
}
function retry_unposted(string $ref): array {
    $dir=config('EXCHANGE_ROOT','/data/exchange');
    if (!is_dir($dir)) mkdir($dir,0770,true);
    $lock=fopen($dir.'/batch.lock','c');
    if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Cannot acquire batch lock');
    try {
        $result=inquiry($ref);
        if ($result['coreOutcome']==='NOTFOUND') {
            db()->prepare("UPDATE requests SET status='RECEIVED',reason=NULL WHERE reference=? AND status NOT IN ('POSTED','DECLINED')")->execute([$ref]);
        }
        return public_row(lookup($ref));
    } finally { flock($lock,LOCK_UN); fclose($lock); }
}
function batch(bool $dropResult = false): array {
    $dir = config('EXCHANGE_ROOT','/data/exchange');
    if (!is_dir($dir)) mkdir($dir,0770,true);
    $lock = fopen($dir.'/batch.lock','c');
    if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Cannot acquire batch lock');
    try {
        db()->beginTransaction();
        $rows = db()->query("SELECT * FROM requests WHERE status='RECEIVED' ORDER BY created_at,reference LIMIT 100 FOR UPDATE")->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) { db()->commit(); return ['records'=>0]; }
        $id = uuid(); $data = ''; $total = 0;
        foreach ($rows as $row) { $data .= record_line($row); $total += (int)$row['amount_minor']; }
        $checksum = hash('sha256',$data);
        durable_write($dir.'/'.$id.'.dat',$data);
        durable_write($dir.'/'.$id.'.json',json_encode(['id'=>$id,'recordCount'=>count($rows),
            'amountTotal'=>$total,'sha256'=>$checksum],JSON_THROW_ON_ERROR));
        $stmt = db()->prepare("INSERT INTO batch_runs (id,record_count,amount_total,checksum,status) VALUES (?,?,?,?,'PROCESSING')");
        $stmt->execute([$id,count($rows),$total,$checksum]);
        $update = db()->prepare("UPDATE requests SET status='BATCHED',batch_id=? WHERE reference=?");
        $item = db()->prepare('INSERT INTO batch_items (batch_id,reference,amount_minor) VALUES (?,?,?)');
        foreach ($rows as $row) {
            $update->execute([$id,$row['reference']]);
            $item->execute([$id,$row['reference'],$row['amount_minor']]);
        }
        db()->commit();
        try {
            if (!hash_equals($checksum,hash_file('sha256',$dir.'/'.$id.'.dat')))
                throw new RuntimeException('Batch checksum changed before core delivery');
            $result = core_run('POST',$dir.'/'.$id.'.dat');
            if ($dropResult) throw new RuntimeException('Injected missing result after core commit');
            durable_write($dir.'/'.$id.'.result.json',json_encode($result,JSON_THROW_ON_ERROR));
            import_result($result);
            db()->prepare("UPDATE batch_runs SET status='IMPORTED' WHERE id=?")->execute([$id]);
            return ['batchId'=>$id,'records'=>count($rows),'status'=>'IMPORTED'];
        } catch (Throwable $e) {
            db()->prepare("UPDATE requests SET status='VERIFYING',reason='CORE_INQUIRY_REQUIRED' WHERE batch_id=? AND status='BATCHED'")->execute([$id]);
            db()->prepare("UPDATE batch_runs SET status='VERIFYING' WHERE id=?")->execute([$id]);
            throw $e;
        }
    } finally {
        if (db()->inTransaction()) db()->rollBack();
        flock($lock,LOCK_UN); fclose($lock);
    }
}

function batch_controls(): array {
    $rows = db()->query("SELECT b.*,
        COUNT(i.reference) AS submitted_count,COALESCE(SUM(i.amount_minor),0) AS submitted_total,
        COALESCE(SUM(r.status IN ('POSTED','DECLINED')),0) AS terminal_count,
        COALESCE(SUM(r.status='POSTED'),0) AS posted_count,
        COALESCE(SUM(r.status='DECLINED'),0) AS declined_count,
        COALESCE(SUM(CASE WHEN r.status='POSTED' THEN i.amount_minor ELSE 0 END),0) AS posted_total,
        COALESCE(SUM(CASE WHEN r.status='DECLINED' THEN i.amount_minor ELSE 0 END),0) AS declined_total
        FROM batch_runs b LEFT JOIN batch_items i ON i.batch_id=b.id
        LEFT JOIN requests r ON r.reference=i.reference
        GROUP BY b.id,b.record_count,b.amount_total,b.checksum,b.status,b.created_at
        ORDER BY b.created_at DESC,b.id LIMIT 5001")->fetchAll(PDO::FETCH_ASSOC);
    return array_map(function(array $r): array {
        $numeric = ['record_count','amount_total','submitted_count','submitted_total',
            'terminal_count','posted_count','declined_count','posted_total','declined_total'];
        foreach ($numeric as $key) $r[$key] = (int)$r[$key];
        $r['control_match'] = $r['record_count'] === $r['submitted_count'] && $r['amount_total'] === $r['submitted_total'];
        $r['unresolved_count'] = $r['submitted_count'] - $r['terminal_count'];
        return $r;
    },$rows);
}
function reconciliation_inventory(): array {
    db()->beginTransaction();
    try {
        $requests = db()->query('SELECT * FROM requests ORDER BY reference LIMIT 5001')->fetchAll(PDO::FETCH_ASSOC);
        $batches = batch_controls();
        $core = core_run('AUDIT');
        db()->commit();
        return ['requests'=>array_map('public_row',array_slice($requests,0,5000)),
            'batches'=>array_slice($batches,0,5000), 'core'=>$core,
            'truncated'=>count($requests)>5000 || count($batches)>5000 || $core['truncated']];
    } catch (Throwable $e) { db()->rollBack(); throw $e; }
}
function csv_text(array $columns, array $rows): string {
    $stream = fopen('php://temp','w+');
    $safe = static fn(mixed $v): string => preg_match('/^[=+@\t\r-]/',(string)$v) ? "'".(string)$v : (string)$v;
    fputcsv($stream,array_map($safe,$columns),',','"','');
    foreach ($rows as $row) fputcsv($stream,array_map($safe,$row),',','"','');
    rewind($stream); $text = stream_get_contents($stream); fclose($stream); return $text;
}
