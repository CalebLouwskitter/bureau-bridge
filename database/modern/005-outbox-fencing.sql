IF COL_LENGTH('dbo.Outbox', 'Status') IS NULL
  ALTER TABLE dbo.Outbox ADD Status VARCHAR(16) NOT NULL CONSTRAINT DF_Outbox_Status DEFAULT 'PENDING';

IF COL_LENGTH('dbo.Outbox', 'NextAttemptAtUtc') IS NULL
  ALTER TABLE dbo.Outbox ADD NextAttemptAtUtc DATETIME2 NULL CONSTRAINT DF_Outbox_NextAttemptAtUtc DEFAULT SYSUTCDATETIME();

IF COL_LENGTH('dbo.Outbox', 'LockedUntilUtc') IS NULL
  ALTER TABLE dbo.Outbox ADD LockedUntilUtc DATETIME2 NULL;

IF COL_LENGTH('dbo.Outbox', 'FencingToken') IS NULL
  ALTER TABLE dbo.Outbox ADD FencingToken BIGINT NOT NULL CONSTRAINT DF_Outbox_FencingToken DEFAULT 0;

IF OBJECT_ID('dbo.CK_Outbox_Status', 'C') IS NULL
  EXEC(N'ALTER TABLE dbo.Outbox ADD CONSTRAINT CK_Outbox_Status
    CHECK (Status IN (''PENDING'',''CLAIMED'',''COMPLETED'',''DEAD_LETTER''))');

EXEC(N'UPDATE dbo.Outbox
  SET NextAttemptAtUtc = COALESCE(NextAttemptAtUtc, DueAt),
      LockedUntilUtc = COALESCE(LockedUntilUtc, LeaseUntil),
      Status = CASE
        WHEN DueAt IS NULL AND Failures >= 6 THEN ''DEAD_LETTER''
        WHEN DueAt IS NULL THEN ''COMPLETED''
        WHEN LeaseUntil IS NOT NULL AND LeaseUntil >= SYSUTCDATETIME() THEN ''CLAIMED''
        ELSE ''PENDING''
      END
  WHERE Status = ''PENDING'' AND (DueAt IS NULL OR LeaseUntil IS NOT NULL);');

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.Outbox') AND name = 'IX_Outbox_Claim'
)
  EXEC(N'CREATE INDEX IX_Outbox_Claim ON dbo.Outbox(Status, NextAttemptAtUtc, LockedUntilUtc);');
