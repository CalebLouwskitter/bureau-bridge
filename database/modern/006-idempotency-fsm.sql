IF OBJECT_ID('dbo.IdempotencyKeys','U') IS NULL
BEGIN
  CREATE TABLE dbo.IdempotencyKeys (
    ClientId VARCHAR(30) NOT NULL,
    IdempotencyKey CHAR(36) NOT NULL,
    Fingerprint CHAR(64) NOT NULL,
    State VARCHAR(16) NOT NULL CHECK (State IN ('IN_PROGRESS','COMPLETED')),
    ResponseStatus INT NULL,
    ResponseBody NVARCHAR(MAX) NULL,
    AllocationId CHAR(36) NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    ExpiresAt DATETIME2 NOT NULL,
    CONSTRAINT PK_IdempotencyKeys PRIMARY KEY (ClientId, IdempotencyKey),
    CONSTRAINT CK_IdempotencyKeys_State CHECK (
      (State = 'IN_PROGRESS' AND ResponseStatus IS NULL AND ResponseBody IS NULL) OR
      (State = 'COMPLETED' AND ResponseStatus IS NOT NULL AND ResponseBody IS NOT NULL)
    )
  );
  CREATE INDEX IX_IdempotencyKeys_Expires ON dbo.IdempotencyKeys(ExpiresAt);
END;

IF OBJECT_ID('dbo.AllocationStateTransitions','U') IS NULL
BEGIN
  CREATE TABLE dbo.AllocationStateTransitions (
    FromStatus VARCHAR(24) NOT NULL,
    ToStatus VARCHAR(24) NOT NULL,
    CONSTRAINT PK_AllocationStateTransitions PRIMARY KEY (FromStatus, ToStatus)
  );
END;

EXEC(N'
  MERGE dbo.AllocationStateTransitions AS target
  USING (VALUES
    (''QUEUED'', ''AWAITING_BATCH''),
    (''QUEUED'', ''PROCESSING''),
    (''QUEUED'', ''VERIFYING''),
    (''QUEUED'', ''POSTED''),
    (''QUEUED'', ''DECLINED''),
    (''QUEUED'', ''NEEDS_REVIEW''),
    (''AWAITING_BATCH'', ''PROCESSING''),
    (''AWAITING_BATCH'', ''VERIFYING''),
    (''AWAITING_BATCH'', ''POSTED''),
    (''AWAITING_BATCH'', ''DECLINED''),
    (''AWAITING_BATCH'', ''NEEDS_REVIEW''),
    (''PROCESSING'', ''VERIFYING''),
    (''PROCESSING'', ''POSTED''),
    (''PROCESSING'', ''DECLINED''),
    (''PROCESSING'', ''NEEDS_REVIEW''),
    (''VERIFYING'', ''AWAITING_BATCH''),
    (''VERIFYING'', ''PROCESSING''),
    (''VERIFYING'', ''POSTED''),
    (''VERIFYING'', ''DECLINED''),
    (''VERIFYING'', ''NEEDS_REVIEW''),
    (''NEEDS_REVIEW'', ''AWAITING_BATCH''),
    (''NEEDS_REVIEW'', ''PROCESSING''),
    (''NEEDS_REVIEW'', ''VERIFYING''),
    (''NEEDS_REVIEW'', ''POSTED''),
    (''NEEDS_REVIEW'', ''DECLINED'')
  ) AS source (FromStatus, ToStatus)
  ON target.FromStatus = source.FromStatus AND target.ToStatus = source.ToStatus
  WHEN NOT MATCHED THEN
    INSERT (FromStatus, ToStatus) VALUES (source.FromStatus, source.ToStatus);
');

IF OBJECT_ID('dbo.CK_Allocations_PostingContract', 'C') IS NULL
  EXEC(N'ALTER TABLE dbo.Allocations ADD CONSTRAINT CK_Allocations_PostingContract
    CHECK ((Status <> ''POSTED'' OR PostingId = Id) AND (Status <> ''DECLINED'' OR PostingId IS NULL))');

EXEC sp_executesql N'
CREATE OR ALTER TRIGGER dbo.TR_Allocations_EnforceFSM
ON dbo.Allocations
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT (UPDATE(Status) OR UPDATE(PostingId)) RETURN;

  IF EXISTS (
    SELECT 1
    FROM deleted d
    JOIN inserted i ON i.Id = d.Id
    WHERE d.Status IN (''POSTED'', ''DECLINED'')
      AND (i.Status <> d.Status OR ISNULL(i.PostingId, '''') <> ISNULL(d.PostingId, ''''))
  )
  BEGIN
    THROW 51010, ''Terminal allocation status (POSTED/DECLINED) cannot regress or mutate'', 1;
  END;

  IF EXISTS (
    SELECT 1
    FROM deleted d
    JOIN inserted i ON i.Id = d.Id
    WHERE i.Status <> d.Status
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.AllocationStateTransitions t
        WHERE t.FromStatus = d.Status AND t.ToStatus = i.Status
      )
  )
  BEGIN
    THROW 51011, ''Invalid allocation state transition'', 1;
  END;
END;';
