<?php
declare(strict_types=1);
require __DIR__.'/lib.php';
$files = glob(__DIR__.'/../schema/*.sql');
if ($files !== false) {
    foreach ($files as $path) {
        $sql = file_get_contents($path);
        if ($sql !== false) {
            db()->exec($sql);
        }
    }
}
echo "Legacy schema ready\n";
