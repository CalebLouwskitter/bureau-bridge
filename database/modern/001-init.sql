IF OBJECT_ID('dbo.Allocations','U') IS NULL
BEGIN
  CREATE TABLE dbo.Allocations (
    Id CHAR(36) NOT NULL PRIMARY KEY,
    ClientId VARCHAR(30) NOT NULL,
    IdempotencyKey CHAR(36) NOT NULL,
    Fingerprint CHAR(64) NOT NULL,
    SourceAccount CHAR(12) NOT NULL,
    TargetAccount CHAR(12) NOT NULL,
    AmountMinor BIGINT NOT NULL CHECK (AmountMinor BETWEEN 1 AND 999999999999),
    Currency CHAR(3) NOT NULL CHECK (Currency='ZAR'),
    Status VARCHAR(24) NOT NULL CHECK (Status IN ('QUEUED','AWAITING_BATCH','PROCESSING','VERIFYING','POSTED','DECLINED','NEEDS_REVIEW')),
    Reason VARCHAR(80) NULL,
    PostingId CHAR(36) NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Allocation_Key UNIQUE (ClientId,IdempotencyKey)
  );
  CREATE TABLE dbo.Outbox (
    AllocationId CHAR(36) NOT NULL PRIMARY KEY REFERENCES dbo.Allocations(Id),
    DueAt DATETIME2 NULL DEFAULT SYSUTCDATETIME(),
    LeaseUntil DATETIME2 NULL,
    LeaseToken CHAR(36) NULL,
    Failures INT NOT NULL DEFAULT 0,
    LastError VARCHAR(80) NULL
  );
  CREATE INDEX IX_Outbox_Due ON dbo.Outbox(DueAt,LeaseUntil);
  CREATE TABLE dbo.AllocationEvents (
    Id BIGINT IDENTITY PRIMARY KEY,
    AllocationId CHAR(36) NOT NULL REFERENCES dbo.Allocations(Id),
    Status VARCHAR(24) NOT NULL,
    Reason VARCHAR(80) NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_Events_Allocation ON dbo.AllocationEvents(AllocationId,Id);
END;
