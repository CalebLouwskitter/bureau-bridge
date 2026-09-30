<?php
declare(strict_types=1);
require __DIR__.'/lib.php';
try { echo json_encode(batch(in_array('--drop-result',$argv,true)),JSON_THROW_ON_ERROR)."\n"; }
catch (Throwable $e) { fwrite(STDERR,$e->getMessage()."\n"); exit(1); }
