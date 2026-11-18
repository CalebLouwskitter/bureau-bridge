IF COL_LENGTH('dbo.Allocations', 'Traceparent') IS NULL
  ALTER TABLE dbo.Allocations ADD Traceparent VARCHAR(128) NULL;

IF COL_LENGTH('dbo.Outbox', 'Traceparent') IS NULL
  ALTER TABLE dbo.Outbox ADD Traceparent VARCHAR(128) NULL;

IF COL_LENGTH('dbo.AllocationEvents', 'Traceparent') IS NULL
  ALTER TABLE dbo.AllocationEvents ADD Traceparent VARCHAR(128) NULL;
