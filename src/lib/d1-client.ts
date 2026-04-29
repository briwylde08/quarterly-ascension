// Async D1 HTTP client.
//
// We talk to D1 from the local orchestrator over Cloudflare's REST API. This
// is Phase 2 of the migration: the orchestrator is still a long-running Node
// process on the laptop, but persistence has moved off local SQLite. Phase 3
// will move the orchestrator into a Durable Object with a direct D1 binding,
// at which point this client gets retired.
//
// The surface intentionally mirrors better-sqlite3's prepare/run/get/all so
// the rewrite of db.ts is mostly s/sync/await/. The big semantic difference:
// every method here is async.

const ENDPOINT = (account: string, dbId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${dbId}/query`;

interface D1QueryResultMeta {
  duration?: number;
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

interface D1QueryResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1QueryResultMeta;
}

interface D1ApiResponse<T = Record<string, unknown>> {
  result: D1QueryResult<T>[];
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class D1Error extends Error {
  constructor(
    message: string,
    public readonly sql: string,
    public readonly cfErrors: Array<{ code: number; message: string }> = []
  ) {
    super(message);
    this.name = "D1Error";
  }
}

function getEnv(): { token: string; account: string; dbId: string } {
  // Read D1_API_TOKEN (preferred) and fall back to CLOUDFLARE_API_TOKEN for
  // back-compat. They were the same name historically, but wrangler v4 also
  // auto-loads CLOUDFLARE_API_TOKEN from .env at the project root and that
  // hijacks deploys when the D1 token lacks `pages:write` scope. Renaming
  // ours sidesteps the collision.
  const token = process.env.D1_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const dbId = process.env.CF_D1_DATABASE_ID;
  if (!token || !account || !dbId) {
    throw new Error(
      "D1 client missing env: D1_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID must all be set"
    );
  }
  return { token, account, dbId };
}

async function rawQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[]
): Promise<D1QueryResult<T>> {
  const { token, account, dbId } = getEnv();
  const res = await fetch(ENDPOINT(account, dbId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new D1Error(
      `D1 HTTP ${res.status}: ${text.slice(0, 500)}`,
      sql
    );
  }

  const json = (await res.json()) as D1ApiResponse<T>;
  if (!json.success) {
    throw new D1Error(
      `D1 query failed: ${json.errors.map((e) => e.message).join("; ")}`,
      sql,
      json.errors
    );
  }
  // Single-statement queries return a one-element result array.
  return json.result[0];
}

/**
 * Prepared-statement-style wrapper. Mirrors the subset of better-sqlite3's
 * Statement API that the rest of the codebase actually uses.
 *
 * Note: there is no real prepare on the wire — D1's REST API takes sql+params
 * per call. "Prepare" here is just sugar for binding the SQL string so the
 * call sites read the same as before.
 */
export class D1Statement {
  constructor(private readonly sql: string) {}

  async run(...params: unknown[]): Promise<RunResult> {
    const result = await rawQuery(this.sql, params);
    return {
      changes: result.meta.changes ?? 0,
      lastInsertRowid: result.meta.last_row_id ?? 0,
    };
  }

  async get<T = Record<string, unknown>>(
    ...params: unknown[]
  ): Promise<T | undefined> {
    const result = await rawQuery<T>(this.sql, params);
    return result.results[0];
  }

  async all<T = Record<string, unknown>>(
    ...params: unknown[]
  ): Promise<T[]> {
    const result = await rawQuery<T>(this.sql, params);
    return result.results;
  }
}

export const d1 = {
  prepare(sql: string): D1Statement {
    return new D1Statement(sql);
  },

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return new D1Statement(sql).run(...params);
  },

  async first<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return new D1Statement(sql).get<T>(...params);
  },

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return new D1Statement(sql).all<T>(...params);
  },

  /**
   * Execute a multi-statement SQL script (no params). Used for migrations.
   * D1's /query endpoint accepts multiple `;`-separated statements as a
   * single call when there are no bindings.
   */
  async exec(sql: string): Promise<void> {
    await rawQuery(sql, []);
  },
};
