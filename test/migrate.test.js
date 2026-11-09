import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateDatabase, runMigrations } from "../migrate.js";

async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), "purchase-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(directory, name), sql);
  return directory;
}

function fakeClient({ failSQL } = {}) {
  const history = new Map();
  const calls = [];
  let pending;
  return {
    history, calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === failSQL) throw new Error("simulated SQL failure");
      if (sql.startsWith("SELECT revision")) return { rows: [...history].map(([revision, checksum]) => ({ revision, checksum })) };
      if (sql === "BEGIN") pending = new Map(history);
      if (sql.startsWith("INSERT INTO schema_migrations")) pending.set(params[0], params[1]);
      if (sql === "COMMIT") { history.clear(); for (const pair of pending) history.set(...pair); pending = undefined; }
      if (sql === "ROLLBACK") pending = undefined;
      return { rows: [] };
    },
  };
}

test("orders filenames, wraps each file and history in a transaction, skips already applied files", async (t) => {
  const directory = await fixture(t, { "010_last.sql": "SELECT 10;", "002_next.sql": "SELECT 2;", "001_first.sql": "SELECT 1;" });
  const client = fakeClient();
  assert.deepEqual(await runMigrations(client, { directory }), ["001_first", "002_next", "010_last"]);
  const sql = client.calls.map((call) => call.sql);
  assert.match(sql[0], /pg_advisory_lock/);
  assert.match(sql.at(-1), /pg_advisory_unlock/);
  for (const statement of ["SELECT 1;", "SELECT 2;", "SELECT 10;"]) {
    const index = sql.indexOf(statement);
    assert.equal(sql[index - 1], "BEGIN");
    assert.match(sql[index + 1], /^INSERT INTO schema_migrations/);
    assert.equal(sql[index + 2], "COMMIT");
  }
  client.calls.length = 0;
  assert.deepEqual(await runMigrations(client, { directory }), []);
  assert.equal(client.calls.some((call) => call.sql === "BEGIN"), false);
});

test("rolls back failed file, leaves it unrecorded and does not run later files", async (t) => {
  const directory = await fixture(t, { "001_first.sql": "SELECT 1;", "002_fail.sql": "FAIL;", "003_last.sql": "SELECT 3;" });
  const client = fakeClient({ failSQL: "FAIL;" });
  await assert.rejects(runMigrations(client, { directory }), /002_fail.sql.*revertida/);
  assert.deepEqual([...client.history.keys()], ["001_first"]);
  assert.equal(client.calls.at(-2).sql, "ROLLBACK");
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock/);
  assert.equal(client.calls.some((call) => call.sql === "SELECT 3;"), false);
});

test("rejects changed, removed, duplicate and out-of-order revisions", async (t) => {
  const directory = await fixture(t, { "002_applied.sql": "SELECT 2;" });
  const client = fakeClient();
  await runMigrations(client, { directory });
  await writeFile(join(directory, "001_late.sql"), "SELECT 1;");
  await assert.rejects(runMigrations(client, { directory }), /fora de ordem/);
  await rm(join(directory, "001_late.sql"));
  await writeFile(join(directory, "002_applied.sql"), "SELECT 22;");
  await assert.rejects(runMigrations(client, { directory }), /removida ou alterada/);
  await rm(join(directory, "002_applied.sql"));
  await assert.rejects(runMigrations(client, { directory }), /removida ou alterada/);
  for (const name of ["bad.sql", "001_a.sql"]) await writeFile(join(directory, name), "SELECT 1;");
  await assert.rejects(runMigrations(fakeClient(), { directory }), /NNN_name.sql/);
  await rm(join(directory, "bad.sql"));
  await writeFile(join(directory, "001_b.sql"), "SELECT 1;");
  await assert.rejects(runMigrations(fakeClient(), { directory }), /números únicos/);
});

test("releases dedicated connection even when migration SQL fails", async () => {
  let released = false;
  const client = { async query() { throw new Error("database unavailable"); }, release() { released = true; } };
  await assert.rejects(migrateDatabase({ async connect() { return client; } }), /database unavailable/);
  assert.equal(released, true);
});
