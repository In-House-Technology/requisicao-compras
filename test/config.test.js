import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { effectiveConfig, loadConfig, validateConfig } from "../config.js";
import { start } from "../server.js";

const manifestText = await readFile(new URL("../ihapp-catalog.yaml", import.meta.url), "utf8");
const points = parse(manifestText).config;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "purchase-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "ihapp-catalog.yaml"), manifestText);
  return directory;
}

test("absent config applies fresh defaults; overrides replace entire lists", async (t) => {
  const directory = await fixture(t);
  assert.deepEqual(await loadConfig(directory), { company_name: "Sua empresa", approver_groups: ["ihc-admins"], approver_emails: [] });
  const config = effectiveConfig(points, { approver_groups: ["compras"], approver_emails: ["gestor@example.com"] });
  assert.deepEqual(config.approver_groups, ["compras"]);
  config.approver_groups.push("outro");
  assert.deepEqual(effectiveConfig(points, {}).approver_groups, ["ihc-admins"]);
});

test("rejects unknown keys, wrong types, nulls, invalid emails/groups and list bounds", () => {
  const invalid = [null, [], "texto", { extra: true }, { company_name: 12 }, { company_name: null },
    { company_name: "a".repeat(101) }, { approver_groups: "compras" }, { approver_groups: [] },
    { approver_groups: [""] }, { approver_groups: ["   "] }, { approver_groups: [12] },
    { approver_emails: ["sem-arroba"] }, { approver_emails: [null] }, { approver_emails: false }];
  for (const values of invalid) assert.ok(validateConfig(points, values).length, JSON.stringify(values));
  assert.deepEqual(validateConfig(points, { company_name: "😀".repeat(100), approver_emails: [] }), []);
});

test("enforces required points, defaults for required points, patterns and numeric bounds", () => {
  const required = [{ key: "contact", type: "email", required: true }];
  assert.match(validateConfig(required, {}).join(), /contact.*obrigatória/);
  assert.deepEqual(effectiveConfig([{ ...required[0], default: "a@example.com" }], {}), { contact: "a@example.com" });
  assert.ok(validateConfig([{ key: "code", type: "string", pattern: "^[A-Z]+$" }], { code: "abc" }).length);
  for (const value of [0, 11, 1.5, Infinity, "2"]) {
    assert.ok(validateConfig([{ key: "limit", type: "integer", minimum: 1, maximum: 10 }], { limit: value }).length);
  }
  assert.ok(validateConfig([{ key: "list", type: "list", items: { type: "email" }, max_items: 0 }], { list: ["a@example.com"] }).length);
});

test("loads valid YAML; invalid syntax, duplicates, empty file and invalid fields are actionable", async (t) => {
  const directory = await fixture(t);
  const path = join(directory, "ihapp-config.yaml");
  await writeFile(path, "company_name: Empresa de teste\napprover_groups:\n  - compras\n");
  assert.equal((await loadConfig(directory)).company_name, "Empresa de teste");
  for (const text of ["company_name: [", "company_name: A\ncompany_name: B\n"]) {
    await writeFile(path, text);
    await assert.rejects(loadConfig(directory), /ihapp-config.yaml.*sintaxe YAML/);
  }
  await writeFile(path, "");
  await assert.rejects(loadConfig(directory), /raiz deve ser um mapa/);
  await writeFile(path, "approver_groups: []\n");
  await assert.rejects(loadConfig(directory), /approver_groups.*mínimo/);
  let databaseTouched = false;
  await assert.rejects(start({ directory, poolFactory() { databaseTouched = true; } }), /approver_groups/);
  assert.equal(databaseTouched, false, "invalid config must stop before opening database or HTTP");
});
