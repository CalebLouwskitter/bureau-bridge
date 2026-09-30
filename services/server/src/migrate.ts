import { readFile, readdir } from "node:fs/promises";
import { connection } from "./store.ts";
import { env } from "./config.ts";
const database = env("MSSQL_DATABASE", "BureauBridge"),
  user = env("MSSQL_USER", "bureau_app"),
  password = env("MSSQL_PASSWORD");
if (
  !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(database) ||
  !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(user) ||
  !/^[A-Za-z0-9!_]{20,100}$/.test(password)
)
  throw new Error("Use generated database identifiers/passwords");
const master = await connection("master", true).connect();
try {
  await master.request()
    .batch(`IF DB_ID(N'${database}') IS NULL CREATE DATABASE [${database}];
 IF NOT EXISTS(SELECT 1 FROM sys.server_principals WHERE name=N'${user}')
 CREATE LOGIN [${user}] WITH PASSWORD=N'${password}';`);
} finally {
  await master.close();
}
const pool = await connection(database, true).connect();
try {
  const directory = new URL("../../../database/modern/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort())
    await pool
      .request()
      .batch(
        "SET XACT_ABORT ON; BEGIN TRAN;\n" +
          (await readFile(new URL(name, directory), "utf8")) +
          "\nCOMMIT;",
      );
  await pool.request()
    .batch(`IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE name=N'${user}')
 BEGIN CREATE USER [${user}] FOR LOGIN [${user}]; ALTER ROLE db_datareader ADD MEMBER [${user}]; ALTER ROLE db_datawriter ADD MEMBER [${user}]; END;`);
  console.log("Modern schema ready. Runtime uses the application login.");
} finally {
  await pool.close();
}
