import { Client } from "pg";
import { z } from "zod/v4";
import { config } from "@/lib/config";

const isolationSchema = z.object({
  database: z.string(),
  privileged: z.boolean(),
});

export async function executeOncallSql(
  sql: string,
  operateType: string,
  connectionString = config.oncallDatabaseUrl,
): Promise<unknown> {
  if (!connectionString)
    throw new Error(
      "OnCall SQL is unavailable: configure ONCALL_DATABASE_URL with a separate database and restricted role.",
    );
  const application = new URL(config.database.url);
  const target = new URL(connectionString);
  const applicationDatabase = decodeURIComponent(application.pathname.slice(1));
  const applicationUser = decodeURIComponent(application.username);
  if (
    !target.pathname.slice(1) ||
    !target.username ||
    decodeURIComponent(target.pathname.slice(1)) === applicationDatabase ||
    decodeURIComponent(target.username) === applicationUser
  ) {
    throw new Error(
      "OnCall SQL cannot reuse the application database or database role.",
    );
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
  });
  try {
    await client.connect();
    const check = await client.query({
      text: `SELECT current_database() AS database,
        EXISTS (SELECT 1 FROM pg_roles r WHERE
          (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
           OR r.rolname = $1 OR r.rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))
          AND pg_has_role(session_user, r.oid, 'MEMBER')) AS privileged`,
      values: [applicationUser],
    });
    const isolation = isolationSchema.parse(check.rows[0]);
    if (isolation.database === applicationDatabase || isolation.privileged) {
      throw new Error(
        "OnCall SQL requires an isolated database and a non-administrative role with no application-role membership.",
      );
    }
    const result = await client.query({ text: sql, name: "oncall-query" });
    if (operateType === "query") return result.rows;
    return {
      success: true,
      affected_rows: result.rowCount ?? 0,
      message: `Executed ${operateType} sql`,
    };
  } finally {
    await client.end();
  }
}
