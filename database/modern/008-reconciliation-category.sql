IF COL_LENGTH('dbo.ReconciliationFindings', 'Category') IS NULL
  ALTER TABLE dbo.ReconciliationFindings ADD Category VARCHAR(32) NULL;
