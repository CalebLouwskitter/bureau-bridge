FROM php:8.3-cli-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends gnucobol python3 tzdata \
    && docker-php-ext-install pdo_mysql && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY legacy/ /app/
COPY database/legacy/ /app/schema/
COPY tests/legacy_integration.php /app/tests/legacy_integration.php
RUN chmod +x /app/start.sh
RUN cobc -x -free -Wall -o /app/core /app/cobol/core.cob
ENV CORE_BINARY=/app/core CORE_ROOT=/data/core EXCHANGE_ROOT=/data/exchange
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
CMD ["php", "-S", "0.0.0.0:8080", "/app/php/router.php"]
