import assert from "node:assert/strict";
import { readdir, readFile, access } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { parse } from "yaml";
import { createApp } from "../server.js";
import { effectiveConfig } from "../config.js";
import { request } from "./http-helpers.js";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const catalog = parse(await read("ihapp-catalog.yaml"));
const placeholders = { APP_SLUG: "compras-teste", APP_NAME: "Compras", OWNER_EMAIL: "owner@example.com", APP_DOMAIN: "compras-teste.example.com", APP_GROUP: "ihc-users" };
const manifest = parse((await read("company-app.yaml")).replace(/__([A-Z_]+)__/g, (_, key) => placeholders[key]));
const config = effectiveConfig(catalog.config, {});

test("requires, storage, identity and connector permissions agree with operational manifest", () => {
  assert.equal(catalog.requires.spec_version, manifest.schema_version);
  assert.equal(catalog.requires.starter, "node-minimal");
  const data = { database: manifest.database.required, redis: manifest.dependencies.redis.required, object_storage: manifest.object_storage.required };
  for (const [key, value] of Object.entries(data)) {
    assert.equal(catalog.requires[key], value, key);
    assert.equal(catalog.permissions.data[key], value, key);
  }
  assert.deepEqual(catalog.permissions.identity, { email: true, groups: true });
  assert.deepEqual(Object.keys(manifest.secrets_proxy ?? {}), catalog.permissions.connectors.map((item) => item.service));
  assert.deepEqual(catalog.permissions.egress, []);
  assert.equal(manifest.auth.required, true);
  assert.equal(manifest.database.migrations_command, "node migrate.js");
});

test("all created tables and shipped SQL migrations are declared; UUID and audit columns exist", async () => {
  const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(catalog.releases.flatMap((release) => release.migrations.map((item) => `${item.revision}.sql`)).sort(), names);
  const sql = (await Promise.all(names.map((name) => read(`migrations/${name}`)))).join("\n");
  const runner = await read("migrate.js");
  const tables = [...`${sql}\n${runner}`.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual([...catalog.permissions.data.tables].sort(), tables);
  for (const name of ["created_at", "created_at_epoch", "modified_at", "modified_at_epoch", "deleted_at", "deleted_at_epoch"]) assert.match(sql, new RegExp(`\\b${name}\\b`));
  assert.match(sql, /id UUID PRIMARY KEY/);
  assert.match(sql, /BEFORE INSERT OR UPDATE/);
});

test("origin files, placeholders, version, workflows and licensing are consistent", async () => {
  for (const name of ["ihapp-config.yaml", "ihapp-origin.yaml"]) await assert.rejects(access(new URL(`../${name}`, import.meta.url)), { code: "ENOENT" });
  const raw = await read("company-app.yaml");
  for (const key of Object.keys(placeholders)) assert.ok(raw.includes(`__${key}__`), key);
  for (const name of ["company-app.yaml", ".gitea/workflows/deploy.yml", ".env.example", "docker-compose.yml", "server.js"]) {
    const text = await read(name);
    assert.doesNotMatch(text, /[a-f0-9]{16}\.inhouse\.technology|@estoca\.com\.br|APPROVER_(GROUPS|EMAILS)/i, name);
  }
  const deploy = await read(".gitea/workflows/deploy.yml");
  assert.match(deploy, /APP_SLUG: __APP_SLUG__/);
  assert.match(deploy, /ihc-app deploy/);
  assert.equal(JSON.parse(await read("package.json")).version, catalog.version);
  assert.equal(JSON.parse(await read("package-lock.json")).version, catalog.version);
  assert.equal(catalog.releases[0].version, catalog.version);
  assert.equal(catalog.license, "MIT");
  assert.match(await read("LICENSE"), /MIT License[\s\S]+Copyright \(c\) 2026 Estoca/);
  const ci = parse(await read(".github/workflows/ci.yml"));
  const steps = ci.jobs.validate.steps;
  assert.ok(steps.some((step) => step.run === "npm ci"));
  assert.ok(steps.some((step) => step.run === "npm test"));
  const action = steps.filter((step) => step.uses === "In-House-Technology/ihapp-tools@c2113f6a1f5cb33c40eba8213a1e272227452650");
  assert.equal(action.length, 2);
  assert.ok(action.every((step) => step.with.mode === "app"));
  assert.ok(action.some((step) => step.with.tag && step.with.commit));
});

test("GET /api/me and /me share signed-in identity and require sign-in headers", async () => {
  const server = createApp({ config, pool: {}, env: { APP_SLUG: placeholders.APP_SLUG } });
  for (const groups of [["ihc-users"], ["ihc-users", "ihc-admins"]]) {
    const headers = { "x-authentik-email": "Person@example.com", "x-authentik-name": "Pessoa de teste", "x-authentik-groups": groups.join("|") };
    for (const path of ["/api/me", "/me"]) {
      const response = await request(server, { path, headers });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json(), { email: "person@example.com", name: "Pessoa de teste", groups, isApprover: groups.includes("ihc-admins") });
    }
  }
  for (const path of ["/api/me", "/me"]) {
    for (const headers of [{}, { "x-authentik-name": "Pessoa de teste", "x-authentik-groups": "ihc-admins" }]) {
      const response = await request(server, { path, headers });
      assert.equal(response.status, 401);
      assert.deepEqual(response.json(), { error: "Entre com sua conta da empresa." });
    }
  }
});

test("public /health reports commit precedence and fallback while checking the database", async () => {
  for (const [shaEnv, commit] of [
    [{ COMMIT_SHA: "commit-sha", GIT_SHA: "git-sha" }, "commit-sha"],
    [{ COMMIT_SHA: "commit-sha" }, "commit-sha"],
    [{ GIT_SHA: "git-sha" }, "git-sha"],
    [{ COMMIT_SHA: "", GIT_SHA: "git-sha" }, "git-sha"],
    [{}, null],
    [{ COMMIT_SHA: "", GIT_SHA: "" }, null],
  ]) {
    const queries = [];
    const server = createApp({ config, env: { APP_SLUG: placeholders.APP_SLUG, ...shaEnv }, pool: {
      async query(sql) { queries.push(sql); return { rows: [] }; },
    } });
    const response = await request(server, { path: "/health" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { ok: true, service: placeholders.APP_SLUG, db: true, commit });
    assert.deepEqual(queries, ["SELECT 1"]);
  }
});

test("/health still fails when the database check fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const server = createApp({ config, env: { APP_SLUG: placeholders.APP_SLUG, COMMIT_SHA: "commit-sha" }, pool: {
    async query() { throw new Error("database unavailable"); },
  } });
  const response = await request(server, { path: "/health" });
  assert.equal(response.status, 500);
  assert.deepEqual(response.json(), { error: "Não foi possível concluir a operação." });
});

test("runtime MCP inventory matches both permission manifests and honors renamed slug and audience", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key" };
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }));
  const queries = [];
  const server = createApp({ config, pool: { async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; } }, env: {
    APP_SLUG: placeholders.APP_SLUG, IHC_MCP_AUDIENCE: "custom-audience", IHC_MCP_ISSUER: "test-issuer", IHC_MCP_JWKS_URL: "http://gateway/jwks",
  } });
  const claims = { iss: "test-issuer", aud: "custom-audience", exp: Math.floor(Date.now() / 1000) + 60, email: "person@example.com", groups: ["ihc-users"], scope: "compras-teste.read" };
  function token(overrides = {}, headerOverrides = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const data = `${encode({ alg: "RS256", kid: jwk.kid, ...headerOverrides })}.${encode({ ...claims, ...overrides })}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
  }
  const call = (options = {}, jwt = token()) => request(server, { path: "/mcp/tools", headers: { authorization: `Bearer ${jwt}` }, ...options });
  const response = await call();
  assert.equal(response.status, 200);
  const tools = response.json().tools.map(({ name, access }) => ({ name, access }));
  assert.deepEqual(tools, catalog.permissions.mcp_tools.map(({ name, access }) => ({ name, access })));
  assert.deepEqual(tools, Object.entries(manifest.mcp.tools).map(([name, spec]) => ({ name, access: spec.access })));
  for (const override of [{ iss: "other" }, { aud: "requisicao-compras.mcp" }, { exp: 1 }, { exp: "9999999999" }]) assert.equal((await call({}, token(override))).status, 401);
  assert.equal((await call({}, token({}, { kid: "" }))).status, 401);
  assert.equal((await call({}, `${token()}bad`)).status, 401);
  assert.equal((await call({}, token({ scope: "requisicao-compras.read" }))).status, 403);
  assert.equal((await request(server, { path: "/mcp/tools" })).status, 401);
  const execution = { method: "POST", path: "/mcp/tools/list_requests/execute", body: JSON.stringify({ arguments: { status: "pendente" } }) };
  assert.equal((await call(execution)).status, 200);
  assert.deepEqual(queries.at(-1).params, ["pendente"]);
  assert.match(queries.at(-1).sql, /deleted_at IS NULL/);
  assert.equal((await call({ ...execution, body: '{"arguments":{"status":"invalid"}}' })).status, 400);
  assert.equal((await call({ ...execution, body: 'null' })).status, 400);
});
