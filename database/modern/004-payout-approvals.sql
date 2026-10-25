IF COL_LENGTH('dbo.PayoutFiles', 'CreatedBy') IS NULL
  ALTER TABLE dbo.PayoutFiles ADD CreatedBy VARCHAR(60) NULL;

IF COL_LENGTH('dbo.PayoutFiles', 'ApprovedBy') IS NULL
  ALTER TABLE dbo.PayoutFiles ADD ApprovedBy VARCHAR(60) NULL;

IF COL_LENGTH('dbo.PayoutFiles', 'ApprovedAt') IS NULL
  ALTER TABLE dbo.PayoutFiles ADD ApprovedAt DATETIME2 NULL;

DECLARE @statusCheck nvarchar(300);
SELECT TOP (1) @statusCheck = N'ALTER TABLE dbo.PayoutFiles DROP CONSTRAINT ' + QUOTENAME(name)
  FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.PayoutFiles')
  AND definition LIKE '%Status%' AND name<>'CK_PayoutFiles_Status';
WHILE @statusCheck IS NOT NULL
BEGIN
  EXEC sp_executesql @statusCheck;
  SET @statusCheck = (SELECT TOP (1)
    N'ALTER TABLE dbo.PayoutFiles DROP CONSTRAINT ' + QUOTENAME(name)
    FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.PayoutFiles')
    AND definition LIKE '%Status%' AND name<>'CK_PayoutFiles_Status');
END;

IF OBJECT_ID('dbo.CK_PayoutFiles_Status', 'C') IS NULL
  EXEC(N'ALTER TABLE dbo.PayoutFiles ADD CONSTRAINT CK_PayoutFiles_Status
    CHECK (Status IN (''AWAITING_APPROVAL'',''GENERATED'',''SUBMITTED'',''SUBMISSION_UNKNOWN'',''RESPONSE_PROCESSED'',''REJECTED''))');
