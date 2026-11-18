IF COL_LENGTH('dbo.PayoutInstructions', 'ApprovalHash') IS NULL
  ALTER TABLE dbo.PayoutInstructions ADD ApprovalHash CHAR(64) NULL;

IF COL_LENGTH('dbo.PayoutFiles', 'ApprovalHash') IS NULL
  ALTER TABLE dbo.PayoutFiles ADD ApprovalHash CHAR(64) NULL;

IF OBJECT_ID('dbo.CK_PayoutFiles_MakerChecker', 'C') IS NULL
  EXEC(N'ALTER TABLE dbo.PayoutFiles ADD CONSTRAINT CK_PayoutFiles_MakerChecker
    CHECK (ApprovedBy IS NULL OR CreatedBy IS NULL OR ApprovedBy <> CreatedBy)');
