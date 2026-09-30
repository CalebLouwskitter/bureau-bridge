<?php
declare(strict_types=1);
require __DIR__.'/lib.php';
foreach (glob(__DIR__.'/../schema/*.sql') as $path) db()->exec(file_get_contents($path));
echo "Legacy schema ready\n";
