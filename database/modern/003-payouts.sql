-- Core v3 snapshots include the bank settlement account.
DECLARE @kindCheck nvarchar(300) = (SELECT TOP (1)
  N'ALTER TABLE dbo.AccountProjections DROP CONSTRAINT ' + QUOTENAME(name)
  FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.AccountProjections')
  AND definition LIKE '%Kind%' AND name<>'CK_AccountProjections_Kind');
IF @kindCheck IS NOT NULL EXEC sp_executesql @kindCheck;
IF OBJECT_ID('dbo.CK_AccountProjections_Kind','C') IS NULL
  EXEC(N'ALTER TABLE dbo.AccountProjections ADD CONSTRAINT CK_AccountProjections_Kind
    CHECK (Kind IN (''CLIENT'',''EMPLOYEE'',''SETTLEMENT''))');
IF OBJECT_ID('dbo.PayoutFiles','U') IS NULL
BEGIN
  CREATE TABLE dbo.PayoutFiles (
    Id CHAR(36) NOT NULL PRIMARY KEY,
    ClientId VARCHAR(30) NOT NULL,
    IdempotencyKey CHAR(36) NOT NULL,
    Generation INT NOT NULL CHECK (Generation BETWEEN 1 AND 999999),
    ActionDate DATE NOT NULL,
    ItemCount INT NOT NULL CHECK (ItemCount BETWEEN 1 AND 500),
    AmountTotal BIGINT NOT NULL CHECK (AmountTotal > 0),
    HashTotal BIGINT NOT NULL CHECK (HashTotal >= 0),
    Sha256 CHAR(64) NOT NULL,
    Content VARCHAR(MAX) NOT NULL,
    Status VARCHAR(20) NOT NULL CHECK (Status IN ('GENERATED','SUBMITTED','SUBMISSION_UNKNOWN','RESPONSE_PROCESSED','REJECTED')),
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_PayoutFile_Key UNIQUE (ClientId,IdempotencyKey),
    CONSTRAINT UQ_PayoutFile_Generation UNIQUE (ClientId,Generation)
  );
  -- The instruction shares its Id with the core debit allocation, and that
  -- reference is also the payment reference in the bank file.
  CREATE TABLE dbo.PayoutInstructions (
    Id CHAR(36) NOT NULL PRIMARY KEY REFERENCES dbo.Allocations(Id),
    ClientId VARCHAR(30) NOT NULL,
    EmployeeAccount CHAR(12) NOT NULL,
    AmountMinor BIGINT NOT NULL CHECK (AmountMinor BETWEEN 1 AND 999999999999),
    Branch CHAR(6) NOT NULL,
    BankAccount CHAR(11) NOT NULL,
    Holder VARCHAR(14) NOT NULL,
    PayoutFileId CHAR(36) NULL REFERENCES dbo.PayoutFiles(Id),
    BankOutcome VARCHAR(8) NULL CHECK (BankOutcome IN ('PAID','RETURNED')),
    ReturnCode CHAR(2) NULL,
    ReturnAllocationId CHAR(36) NULL REFERENCES dbo.Allocations(Id),
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Payout_Outcome_Filed CHECK (BankOutcome IS NULL OR PayoutFileId IS NOT NULL),
    CONSTRAINT CK_Payout_Return CHECK (
      (BankOutcome='RETURNED' AND ReturnCode IS NOT NULL AND ReturnAllocationId IS NOT NULL) OR
      (ISNULL(BankOutcome,'')<>'RETURNED' AND ReturnCode IS NULL AND ReturnAllocationId IS NULL))
  );
  CREATE INDEX IX_Payout_Client ON dbo.PayoutInstructions(ClientId,PayoutFileId);
  CREATE INDEX IX_Payout_File ON dbo.PayoutInstructions(PayoutFileId);
  CREATE UNIQUE INDEX UX_Payout_Return ON dbo.PayoutInstructions(ReturnAllocationId)
    WHERE ReturnAllocationId IS NOT NULL;
  -- One processed bank answer per file. Replaying it is detected by hash.
  CREATE TABLE dbo.BankResponses (
    PayoutFileId CHAR(36) NOT NULL PRIMARY KEY REFERENCES dbo.PayoutFiles(Id),
    Sha256 CHAR(64) NOT NULL,
    Status VARCHAR(8) NOT NULL CHECK (Status IN ('ACCEPTED','REJECTED')),
    Content VARCHAR(MAX) NOT NULL,
    ReceivedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;
