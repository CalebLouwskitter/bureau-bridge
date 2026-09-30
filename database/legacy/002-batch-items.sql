CREATE TABLE IF NOT EXISTS batch_items (
  batch_id CHAR(36) NOT NULL,
  reference CHAR(36) NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (batch_id, reference),
  FOREIGN KEY (batch_id) REFERENCES batch_runs(id),
  FOREIGN KEY (reference) REFERENCES requests(reference)
);
-- Best-effort backfill of membership still present in the v0.1 register.
INSERT IGNORE INTO batch_items (batch_id,reference,amount_minor)
SELECT batch_id,reference,amount_minor FROM requests WHERE batch_id IS NOT NULL;
