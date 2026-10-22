/**
 * Schema-state detection: the database behind the code, and what
 * `_prisma_migrations` actually holds.
 *
 * The behaviour under test is the guard that lets the service refuse to serve
 * a schema it cannot write to. The investigation behind choosing `db push`
 * (and not `migrate deploy`) is recorded in docs/drift-recovery.md; these
 * tests pin the detection, not the database itself, so they run without one.
 */
import {
  auditMigrationHistory,
  expectedSchema,
  findMissingSchemaObjects,
  listCommittedMigrations,
  missingSchemaObjects,
  summarizeMigrationHistory,
  type MigrationRow,
  type RawQueryable,
} from "../schemaState";

describe("expectedSchema", () => {
  it("uses mapped names and does not turn a relation into a column", () => {
    const models = [
      {
        name: "Widget",
        dbName: "widgets",
        fields: [
          { name: "id", kind: "scalar" },
          { name: "displayName", dbName: "display_name", kind: "scalar" },
          { name: "status", kind: "enum" },
          { name: "owner", kind: "object" },
        ],
      },
    ];

    expect(expectedSchema(models)).toEqual([
      { table: "widgets", columns: ["id", "display_name", "status"] },
    ]);
  });

  it("describes the generated client's real models and columns", () => {
    const schema = expectedSchema();
    const offramp = schema.find((entry) => entry.table === "OfframpOrder");

    expect(schema.length).toBeGreaterThan(10);
    expect(offramp).toBeDefined();
    // A column added by the requestHash work (#210) — the case that motivated
    // this check: a deploy without it fails on the offramp's first insert.
    expect(offramp!.columns).toEqual(expect.arrayContaining(["id", "orderId", "requestHash"]));
  });
});

describe("findMissingSchemaObjects", () => {
  const expected = [{ table: "OfframpOrder", columns: ["id", "orderId", "requestHash"] }];

  it("reports an absent table with every column it would have needed", () => {
    expect(findMissingSchemaObjects(expected, [])).toEqual([
      { table: "OfframpOrder", missingColumns: ["id", "orderId", "requestHash"], tableMissing: true },
    ]);
  });

  it("reports only the columns a present table lacks", () => {
    const actual = [
      { table_schema: "wraith", table_name: "OfframpOrder", column_name: "id" },
      { table_schema: "wraith", table_name: "OfframpOrder", column_name: "orderId" },
    ];

    expect(findMissingSchemaObjects(expected, actual)).toEqual([
      { table: "OfframpOrder", missingColumns: ["requestHash"], tableMissing: false },
    ]);
  });

  it("reports nothing when the table has every column", () => {
    const actual = expected[0].columns.map((column_name) => ({
      table_schema: "wraith",
      table_name: "OfframpOrder",
      column_name,
    }));

    expect(findMissingSchemaObjects(expected, actual)).toEqual([]);
  });

  it("does not let a same-named table in another schema mask a missing column", () => {
    const actual = [
      { table_schema: "wraith", table_name: "OfframpOrder", column_name: "id" },
      { table_schema: "wraith", table_name: "OfframpOrder", column_name: "orderId" },
      { table_schema: "public", table_name: "OfframpOrder", column_name: "id" },
      { table_schema: "public", table_name: "OfframpOrder", column_name: "orderId" },
      { table_schema: "public", table_name: "OfframpOrder", column_name: "requestHash" },
    ];

    // `public` happens to have the column, but the schema the client writes to
    // does not — reporting "fine" here would be the silent-drift failure.
    expect(findMissingSchemaObjects(expected, actual)).toEqual([
      { table: "OfframpOrder", missingColumns: ["requestHash"], tableMissing: false },
    ]);
  });
});

describe("summarizeMigrationHistory", () => {
  it("treats a missing history table as a finding, not an empty history", () => {
    expect(summarizeMigrationHistory(["a", "b"], null)).toEqual({
      historyTablePresent: false,
      historySchema: null,
      appliedCount: 0,
      failedCount: 0,
      unrecorded: ["a", "b"],
      unexpected: [],
    });
  });

  it("separates applied, rolled back, failed and unexpected rows", () => {
    const rows: MigrationRow[] = [
      { migration_name: "a", finished_at: new Date(), rolled_back_at: null },
      { migration_name: "b", finished_at: new Date(), rolled_back_at: new Date() },
      { migration_name: "c", finished_at: null, rolled_back_at: null },
      { migration_name: "z", finished_at: "2026-01-01T00:00:00Z", rolled_back_at: null },
    ];

    expect(summarizeMigrationHistory(["a", "b", "c"], rows, "public")).toEqual({
      historyTablePresent: true,
      historySchema: "public",
      appliedCount: 2,
      failedCount: 1,
      // b was rolled back and c never finished: neither is applied.
      unrecorded: ["b", "c"],
      // z is applied but does not exist in this build's migrations directory.
      unexpected: ["z"],
    });
  });
});

describe("missingSchemaObjects", () => {
  it("queries user schemas and compares them with the expected schema", async () => {
    const db: RawQueryable = {
      $queryRawUnsafe: jest.fn(async () => [
        { table_schema: "wraith", table_name: "Widget", column_name: "id" },
      ]) as RawQueryable["$queryRawUnsafe"],
    };

    await expect(
      missingSchemaObjects(db, [{ table: "Widget", columns: ["id", "name"] }]),
    ).resolves.toEqual([{ table: "Widget", missingColumns: ["name"], tableMissing: false }]);
  });
});

describe("auditMigrationHistory", () => {
  const committed = ["20250101000000_a", "20260624120000_b"];

  it("reports an absent history table without pretending it is empty", async () => {
    const query = jest.fn(async () => []);
    const db: RawQueryable = { $queryRawUnsafe: query as RawQueryable["$queryRawUnsafe"] };

    const audit = await auditMigrationHistory(db, committed);

    expect(query).toHaveBeenCalledTimes(1);
    expect(audit.historyTablePresent).toBe(false);
    expect(audit.unrecorded).toEqual(committed);
  });

  it("reads the table from the schema it lives in and summarises it", async () => {
    const queries: string[] = [];
    const db: RawQueryable = {
      $queryRawUnsafe: jest.fn(async (query: string) => {
        queries.push(query);
        if (queries.length === 1) return [{ table_schema: "wraith" }];
        return [
          { migration_name: "20250101000000_a", finished_at: new Date(), rolled_back_at: null },
          { migration_name: "20260624120000_b", finished_at: null, rolled_back_at: null },
        ];
      }) as RawQueryable["$queryRawUnsafe"],
    };

    const audit = await auditMigrationHistory(db, committed);

    expect(audit).toEqual({
      historyTablePresent: true,
      historySchema: "wraith",
      appliedCount: 1,
      failedCount: 1,
      unrecorded: ["20260624120000_b"],
      unexpected: [],
    });
    expect(queries[1]).toContain('"wraith"."_prisma_migrations"');
  });
});

describe("listCommittedMigrations", () => {
  it("lists migration directories oldest first and skips the lock file", () => {
    const migrations = listCommittedMigrations();

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations).toEqual([...migrations].sort());
    expect(migrations).toContain("20260829120000_add_network");
    expect(migrations).not.toContain("migration_lock.toml");
  });
});
