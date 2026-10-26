/**
 * What the database actually has, versus what this build's schema expects.
 *
 * This is the detection half of wraith's schema strategy (see
 * docs/drift-recovery.md for the whole of it). Two questions, both answered
 * against the live database before the service serves traffic:
 *
 *   1. **Is the database behind the code?** Every model and scalar column in
 *      the generated Prisma client is compared with `information_schema`.
 *      `src/index.ts` runs guarded `db push` and then asks again; anything
 *      still missing is fatal. A route that inserts into a column the database
 *      does not have is exactly the outage this exists to prevent — on the
 *      offramp it is worse than a 500, because the provider order has already
 *      been placed and only our insert would have recorded it.
 *
 *   2. **What does `_prisma_migrations` hold?** Probably nothing. The live
 *      database was built by `db push`, so the table may be absent or may hold
 *      only the migrations someone ran by hand. The audit reports that state
 *      every boot; it never writes to it, never baselines, and never resolves a
 *      migration. Automatically marking an unrecorded migration as applied
 *      would hide a genuinely unapplied one, which is a worse failure than the
 *      noise it silences.
 *
 * Neither check changes anything. `db push` remains the only converging step,
 * and its destructive-change guard is unchanged, so nothing here drops or
 * rewrites a table.
 *
 * Why not `prisma migrate deploy`: the committed migrations cannot build a
 * database. There is no migration creating the `wraith` schema or most of the
 * tables, and a fresh database fails on the first migration with
 * `3F000 schema "wraith" does not exist`; with the schema created it fails on
 * the third with `42P01 relation "wraith"."TokenTransfer" does not exist`.
 * Against a `db push`-built database it refuses with P3005 because the schema
 * is not empty. docs/drift-recovery.md records the investigation in full.
 */
import { readdirSync } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";

/** The subset of the Prisma client these checks need. Tests inject a fake. */
export interface RawQueryable {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** One table the generated client expects, and the columns it writes. */
export interface ExpectedTable {
  table: string;
  columns: string[];
}

/** A table or column the generated client expects but the database lacks. */
export interface MissingSchemaObject {
  table: string;
  missingColumns: string[];
  /** True when the table itself is absent, not just some of its columns. */
  tableMissing: boolean;
}

/** One row of `information_schema.columns`, as the query returns it. */
interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

/**
 * The tables and columns this build expects, derived from the generated
 * client's DMMF rather than from `schema.prisma`.
 *
 * DMMF is what Prisma itself would use, so `@map`/`@@map` names are already
 * resolved. Relation fields (`kind: "object"`) are skipped: they have no
 * column of their own — their foreign key is a scalar field alongside them.
 */
export function expectedSchema(
  models: ReadonlyArray<{
    name: string;
    dbName?: string | null;
    fields: ReadonlyArray<{ name: string; dbName?: string | null; kind: string }>;
  }> = Prisma.dmmf.datamodel.models,
): ExpectedTable[] {
  return models
    .map((model) => ({
      table: model.dbName ?? model.name,
      columns: model.fields
        .filter((field) => field.kind !== "object")
        .map((field) => field.dbName ?? field.name),
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Compare the expected schema with the columns the database reported.
 *
 * The comparison is scoped to the schema that holds this application's
 * tables, identified as the schema covering the most expected table names.
 * That avoids hard-coding `wraith` here while still refusing to let a
 * same-named table in `public` (or a leftover schema) mask a missing column:
 * a table counts as present only when the application schema has it.
 */
export function findMissingSchemaObjects(
  expected: ReadonlyArray<ExpectedTable>,
  actual: ReadonlyArray<ColumnRow>,
): MissingSchemaObject[] {
  const expectedNames = new Set(expected.map((entry) => entry.table));

  // Which schema holds this application's tables? A fresh database has none.
  const coverage = new Map<string, Set<string>>();
  for (const row of actual) {
    if (!expectedNames.has(row.table_name)) continue;
    const tables = coverage.get(row.table_schema) ?? new Set<string>();
    tables.add(row.table_name);
    coverage.set(row.table_schema, tables);
  }
  let appSchema: string | null = null;
  let bestCoverage = -1;
  for (const [schema, tables] of [...coverage].sort(([a], [b]) => a.localeCompare(b))) {
    // On a tie — a fresh or partially restored database — prefer a dedicated
    // schema over `public`, where leftover copies are the likely reason for
    // the duplicate. Within a tier the lexicographic order is stable.
    const betterTie =
      tables.size === bestCoverage && appSchema === "public" && schema !== "public";
    if (tables.size > bestCoverage || betterTie) {
      bestCoverage = tables.size;
      appSchema = schema;
    }
  }

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of actual) {
    if (row.table_schema !== appSchema) continue;
    const columns = columnsByTable.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    columnsByTable.set(row.table_name, columns);
  }

  const missing: MissingSchemaObject[] = [];
  for (const { table, columns } of expected) {
    const present = columnsByTable.get(table);
    if (!present) {
      missing.push({ table, missingColumns: [...columns], tableMissing: true });
      continue;
    }
    const absent = columns.filter((column) => !present.has(column));
    if (absent.length > 0) {
      missing.push({ table, missingColumns: absent, tableMissing: false });
    }
  }
  return missing;
}

/**
 * Ask the database which of this build's tables and columns are absent.
 *
 * Read-only. It queries every user schema because Prisma's generated client
 * qualifies table names with the model's `@@schema` while the connection URL
 * need not carry `?schema=`, so `current_schema()` is not reliable here.
 */
export async function missingSchemaObjects(
  db: RawQueryable,
  expected: ReadonlyArray<ExpectedTable> = expectedSchema(),
): Promise<MissingSchemaObject[]> {
  const rows = await db.$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
  );
  return findMissingSchemaObjects(expected, rows);
}

/** Migration directories committed under `prisma/migrations`, oldest first. */
export function listCommittedMigrations(
  dir: string = path.join(process.cwd(), "prisma", "migrations"),
): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The migration rows this audit reads. */
export interface MigrationRow {
  migration_name: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
}

/**
 * What `_prisma_migrations` says, relative to the migrations on disk.
 *
 * `unrecorded` is the expected finding on a `db push`-built database: every
 * committed migration is absent from history because history was never
 * written. `unexpected` is the opposite and more interesting: the database
 * claims a migration this build does not have, which means the schema may be
 * newer than the code.
 */
export interface MigrationAudit {
  historyTablePresent: boolean;
  historySchema: string | null;
  appliedCount: number;
  failedCount: number;
  unrecorded: string[];
  unexpected: string[];
}

/**
 * Summarise migration rows without touching the database.
 *
 * `rows === null` means the history table does not exist — a finding in
 * itself, not an empty history. Rows that were rolled back are not applied;
 * rows that never finished and were not rolled back are failures, which is
 * what a half-applied `migrate deploy` leaves behind.
 */
export function summarizeMigrationHistory(
  committed: ReadonlyArray<string>,
  rows: ReadonlyArray<MigrationRow> | null,
  historySchema: string | null = null,
): MigrationAudit {
  if (rows === null) {
    return {
      historyTablePresent: false,
      historySchema: null,
      appliedCount: 0,
      failedCount: 0,
      unrecorded: [...committed].sort(),
      unexpected: [],
    };
  }

  const applied = new Set(
    rows
      .filter((row) => row.finished_at != null && row.rolled_back_at == null)
      .map((row) => row.migration_name),
  );
  const onDisk = new Set(committed);

  return {
    historyTablePresent: true,
    historySchema,
    appliedCount: applied.size,
    failedCount: rows.filter((row) => row.finished_at == null && row.rolled_back_at == null)
      .length,
    unrecorded: committed.filter((name) => !applied.has(name)),
    unexpected: [...applied].filter((name) => !onDisk.has(name)).sort(),
  };
}

/**
 * Read `_prisma_migrations` and report it next to the committed migrations.
 *
 * The history table may live in any user schema (`public` by default, but
 * Prisma honours `?schema=`), so it is located first, then queried by its
 * quoted identifier. The identifier comes from database metadata and is
 * escaped; no value from a caller or a request reaches this SQL.
 */
export async function auditMigrationHistory(
  db: RawQueryable,
  committed: ReadonlyArray<string> = listCommittedMigrations(),
): Promise<MigrationAudit> {
  const locations = await db.$queryRawUnsafe<Array<{ table_schema: string }>>(
    `SELECT table_schema
       FROM information_schema.tables
      WHERE table_name = '_prisma_migrations'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema
      LIMIT 1`,
  );

  const schema = locations[0]?.table_schema;
  if (!schema) return summarizeMigrationHistory(committed, null);

  const identifier = `"${schema.replace(/"/g, '""')}"."_prisma_migrations"`;
  const rows = await db.$queryRawUnsafe<MigrationRow[]>(
    `SELECT migration_name, finished_at, rolled_back_at FROM ${identifier}`,
  );
  return summarizeMigrationHistory(committed, rows, schema);
}
