#!/bin/sh
set -eu
php /app/php/migrate.php
exec "$@"
