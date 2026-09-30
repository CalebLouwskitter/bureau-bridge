<?php
declare(strict_types=1);
require __DIR__.'/lib.php';
function respond(mixed $data, int $status=200): never {
    http_response_code($status); header('Content-Type: application/json');
    echo json_encode($data,JSON_THROW_ON_ERROR); exit;
}
function bearer(string $name): void {
    if (!hash_equals('Bearer '.config($name),$_SERVER['HTTP_AUTHORIZATION'] ?? '')) respond(['error'=>'Unauthorized'],401);
}
try {
    $path = parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH);
    $method = $_SERVER['REQUEST_METHOD'];
    if ($path === '/health') { db()->query('SELECT 1'); respond(['status'=>'ok']); }
    if (str_starts_with($path,'/v1/')) {
        if (preg_match('#^/v1/requests/([0-9a-f-]{36})/retry$#D',$path,$matches) && $method==='POST') {
            bearer('LEGACY_OPS_KEY'); respond(retry_unposted($matches[1]));
        }
        if (preg_match('#^/v1/requests/([0-9a-f-]{36})/inquiry$#D',$path,$matches) && $method==='POST') {
            bearer('LEGACY_OPS_KEY'); respond(inquiry($matches[1]));
        }
        bearer('LEGACY_BRIDGE_KEY');
        if ($path==='/v1/accounts' && $method==='GET') respond(core_run('SNAPSHOT'));
        if ($path==='/v1/reconciliation' && $method==='GET') respond(reconciliation_inventory());
        if ($path==='/v1/requests' && $method==='POST') {
            $raw = file_get_contents('php://input',false,null,0,8193);
            if (strlen($raw)>8192) respond(['error'=>'Body too large'],413);
            $data = json_decode($raw,true,32,JSON_THROW_ON_ERROR);
            if (!is_array($data)) respond(['error'=>'Expected object'],400);
            respond(intake($data),202);
        }
        if (preg_match('#^/v1/requests/([0-9a-f-]{36})$#D',$path,$matches) && $method==='GET') {
            $row=lookup($matches[1]);
            if (!$row) respond(['error'=>'Request not found'],404);
            respond(public_row($row));
        }
        respond(['error'=>'Not found'],404);
    }
    if (($_SERVER['PHP_AUTH_USER'] ?? '') !== 'operator' ||
        !hash_equals(config('DEMO_PASSWORD'),$_SERVER['PHP_AUTH_PW'] ?? '')) {
        header('WWW-Authenticate: Basic realm="BureauBridge local demo"');
        http_response_code(401); exit('Sign in as operator');
    }
    if ($method==='GET' && in_array($path,['/reports/requests.csv','/reports/batches.csv'],true)) {
        if ($path==='/reports/requests.csv') {
            $report=db()->query('SELECT * FROM requests ORDER BY created_at,reference LIMIT 5001')->fetchAll(PDO::FETCH_ASSOC);
            $columns=['reference','source_account','target_account','amount_minor','currency','status','reason','posting_id','batch_id'];
        } else {
            $report=batch_controls();
            $columns=['id','status','record_count','amount_total','submitted_count','submitted_total',
                'posted_count','posted_total','declined_count','declined_total','unresolved_count','control_match','checksum'];
        }
        if (count($report)>5000) respond(['error'=>'Report exceeds the demo limit of 5000 rows; narrow or archive data first'],413);
        $values=array_map(static fn(array $r): array => array_map(static fn(string $key): mixed => $r[$key],$columns),$report);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="'.basename($path).'"');
        echo csv_text($columns,$values); exit;
    }
    if (!session_start(['cookie_httponly'=>true,'cookie_samesite'=>'Strict']))
        throw new RuntimeException('Operator session could not start');
    $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    $notice='';
    if ($method==='POST') {
        if (!hash_equals($_SESSION['csrf'],$_POST['csrf'] ?? '')) throw new InvalidArgumentException('Invalid form token');
        if (isset($_POST['run'])) $notice=json_encode(batch(),JSON_THROW_ON_ERROR);
        elseif (isset($_POST['inquire'])) $notice=json_encode(inquiry($_POST['inquire']),JSON_THROW_ON_ERROR);
        else {
            $amount=filter_var($_POST['amountMinor'] ?? '',FILTER_VALIDATE_INT);
            $notice='Received '.intake(['reference'=>uuid(),'sourceAccount'=>'INS000000001',
                'targetAccount'=>$_POST['targetAccount'] ?? '', 'amountMinor'=>$amount,'currency'=>'ZAR'])['reference'];
        }
    }
    $rows=db()->query('SELECT * FROM requests ORDER BY created_at DESC LIMIT 50')->fetchAll(PDO::FETCH_ASSOC);
    $batches=array_slice(batch_controls(),0,50);
    function h(mixed $value): string { return htmlspecialchars((string)$value,ENT_QUOTES,'UTF-8'); }
    require __DIR__.'/portal.php';
} catch (InvalidArgumentException|JsonException $e) { respond(['error'=>$e->getMessage()],400); }
catch (DomainException $e) { respond(['error'=>$e->getMessage()],409); }
catch (OutOfBoundsException $e) { respond(['error'=>$e->getMessage()],404); }
catch (Throwable $e) { error_log($e->getMessage()); respond(['error'=>'Legacy operation needs investigation'],503); }
