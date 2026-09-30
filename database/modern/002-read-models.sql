IF OBJECT_ID('dbo.AccountSync','U') IS NULL
BEGIN
  CREATE TABLE dbo.AccountSync (
    ClientId VARCHAR(30) NOT NULL PRIMARY KEY,
    Generation VARCHAR(64) NOT NULL,
    SourceSequence BIGINT NOT NULL CHECK (SourceSequence>=0),
    ObservedAt DATETIME2 NOT NULL
  );
  CREATE TABLE dbo.AccountProjections (
    ClientId VARCHAR(30) NOT NULL REFERENCES dbo.AccountSync(ClientId),
    Account CHAR(12) NOT NULL,
    AmountMinor BIGINT NOT NULL CHECK (AmountMinor BETWEEN 0 AND 999999999999),
    Currency CHAR(3) NOT NULL CHECK (Currency='ZAR'),
    Kind VARCHAR(12) NOT NULL CHECK (Kind IN ('CLIENT','EMPLOYEE')),
    State VARCHAR(12) NOT NULL CHECK (State IN ('ACTIVE','SUSPENDED')),
    PRIMARY KEY (ClientId,Account)
  );
END;
IF OBJECT_ID('dbo.ReconciliationRuns','U') IS NULL
BEGIN
  CREATE TABLE dbo.ReconciliationRuns (
    Id CHAR(36) NOT NULL PRIMARY KEY,
    ClientId VARCHAR(30) NOT NULL,
    CreatedAt DATETIME2 NOT NULL,
    Generation VARCHAR(64) NOT NULL,
    ObservedAt DATETIME2 NOT NULL,
    ModernCount INT NOT NULL,
    IntakeCount INT NOT NULL,
    CoreCount INT NOT NULL,
    Truncated BIT NOT NULL
  );
  CREATE INDEX IX_Reconciliation_Client ON dbo.ReconciliationRuns(ClientId,CreatedAt);
  CREATE TABLE dbo.ReconciliationFindings (
    Id BIGINT IDENTITY PRIMARY KEY,
    RunId CHAR(36) NOT NULL REFERENCES dbo.ReconciliationRuns(Id),
    Severity VARCHAR(8) NOT NULL CHECK (Severity IN ('HIGH','WARN','INFO')),
    Code VARCHAR(48) NOT NULL,
    Reference CHAR(36) NULL,
    Details NVARCHAR(1000) NOT NULL
  );
  CREATE INDEX IX_Reconciliation_Findings ON dbo.ReconciliationFindings(RunId,Id);
END;
