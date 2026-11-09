import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const defaultDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));

// client must be one dedicated connection: locks and transactions are session scoped.
export async function runMigrations(client, { directory = defaultDirectory } = {}) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) || new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw new Error("Migrações devem ter números únicos e nomes NNN_name.sql.");
  }
  await client.query("SELECT pg_advisory_lock(176845, 1)");
  const applied = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      revision TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query("SELECT revision, checksum FROM schema_migrations ORDER BY revision");
    const previous = new Map(rows.map((row) => [row.revision, row.checksum]));
    const migrations = await Promise.all(names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      return { name, revision: name.slice(0, -4), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }));
    // Verify all history before applying anything. Applied migrations are immutable.
    for (const [revision, checksum] of previous) {
      const migration = migrations.find((item) => item.revision === revision);
      if (!migration || migration.checksum !== checksum) throw new Error(`Migração ${revision} foi removida ou alterada. Restaure o arquivo e crie uma nova revisão.`);
    }
    for (const migration of migrations) {
      if (previous.has(migration.revision)) continue;
      if (rows.some((row) => row.revision > migration.revision)) throw new Error(`Migração ${migration.revision} está fora de ordem. Crie uma revisão posterior às já aplicadas.`);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (revision, checksum) VALUES ($1, $2)", [migration.revision, migration.checksum]);
        await client.query("COMMIT");
        applied.push(migration.revision);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Falha na migração ${migration.name}; transação revertida.`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(176845, 1)");
  }
}

export function createPool(env = process.env) {
  if (!env.DATABASE_URL && !env.PGHOST) throw new Error("Defina DATABASE_URL ou PGHOST/PGDATABASE/PGUSER para o Postgres compartilhado antes de iniciar.");
  return new pg.Pool({ ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}), max: 5, connectionTimeoutMillis: 10_000 });
}

export async function migrateDatabase(pool) {
  const client = await pool.connect();
  try {
    return await runMigrations(client);
  } finally {
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = createPool();
    const applied = await migrateDatabase(pool);
    console.log(`Migrações concluídas: ${applied.join(", ") || "nenhuma pendente"}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}
