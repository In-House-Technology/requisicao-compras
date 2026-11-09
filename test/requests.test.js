import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import http from "node:http";
import test from "node:test";
import { effectiveConfig } from "../config.js";
import { createApp, start } from "../server.js";
import { isApprover, requestStore } from "../requests.js";
import { request } from "./http-helpers.js";

const manifest = parse(await readFile(new URL("../ihapp-catalog.yaml", import.meta.url), "utf8"));
const config = effectiveConfig(manifest.config, {});
const id = "12345678-1234-1234-1234-123456789abc";
const headers = { "x-authentik-email": "person@example.com", "x-authentik-name": "Pessoa de teste", "x-authentik-groups": "ihc-users" };
function fixture(overrides = {}) {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; }, ...overrides };
  return { calls, pool, server: createApp({ config, pool, env: { APP_SLUG: "compras-local" } }) };
}

test("configured group OR email grants approval; email matching is case insensitive", () => {
  const settings = { ...config, approver_groups: ["compras"], approver_emails: ["MANAGER@example.com"] };
  assert.equal(isApprover("person@example.com", ["compras"], settings), true);
  assert.equal(isApprover("manager@example.com", [], settings), true);
  assert.equal(isApprover("person@example.com", ["COMPRAS"], settings), false);
  assert.equal(isApprover("person@example.com", ["ihc-admins"], settings), false);
});

test("SSO required; creates requests with Brazilian numbers and authenticated requester", async () => {
  const { server, calls } = fixture();
  assert.equal((await request(server, { path: "/api/requests" })).status, 401);
  assert.equal((await request(server, { path: "/me", headers })).json().isApprover, false);
  const form = { method: "POST", path: "/requests", headers, body: new URLSearchParams({ description: "Cadeira", quantity: "2,5", estimated_value: "R$ 1.234,56", justification: "Novo posto" }).toString() };
  const created = await request(server, form);
  assert.equal(created.headers.location, "/?msg=criada");
  assert.deepEqual(calls.at(-1).params, ["Cadeira", 2.5, 1234.56, "Novo posto", "person@example.com", "Pessoa de teste"]);
  const before = calls.length;
  assert.equal((await request(server, { ...form, body: "description=Sem+quantidade" })).headers.location, "/?msg=invalida");
  assert.equal((await request(server, { ...form, headers: { ...headers, origin: "https://other.example.com" } })).status, 403);
  assert.equal(calls.length, before);
});

test("decision requires approver and atomically guards ownership, pending status and deletion", async () => {
  const { server, calls } = fixture();
  const form = { method: "POST", path: `/requests/${id}/decision`, headers, body: "action=aprovar&note=Pode+comprar" };
  assert.equal((await request(server, form)).headers.location, "/?msg=sem_permissao");
  assert.equal(calls.length, 0);
  const approverHeaders = { ...headers, "x-authentik-groups": "ihc-users|ihc-admins" };
  for (const [action, status] of [["aprovar", "aprovada"], ["recusar", "recusada"]]) {
    assert.equal((await request(server, { ...form, headers: approverHeaders, body: `action=${action}&note=Comentário` })).headers.location, `/?msg=${status}`);
    const call = calls.at(-1);
    assert.deepEqual(call.params, [status, "person@example.com", "Pessoa de teste", "Comentário", id]);
    assert.match(call.sql, /requester_email <> \$2/);
    assert.match(call.sql, /status='pendente'/);
    assert.match(call.sql, /deleted_at IS NULL/);
  }
  const noMatch = fixture({ async query() { return { rowCount: 0 }; } });
  assert.equal((await request(noMatch.server, { ...form, headers: approverHeaders })).headers.location, "/?msg=ja_decidida");
  assert.equal((await request(server, { ...form, headers: approverHeaders, path: "/requests/1/decision" })).status, 404);
});

test("withdrawal uses soft deletion limited to the pending requester; reads exclude deleted rows", async () => {
  const { server, calls, pool } = fixture();
  const response = await request(server, { method: "POST", path: `/requests/${id}/delete`, headers });
  assert.equal(response.headers.location, "/?msg=retirada");
  assert.match(calls[0].sql, /UPDATE purchase_requests SET deleted_at=statement_timestamp\(\)/);
  assert.match(calls[0].sql, /requester_email=\$2 AND status='pendente' AND deleted_at IS NULL/);
  assert.deepEqual(calls[0].params, [id, "person@example.com"]);
  const store = requestStore(pool);
  for (const status of [undefined, "pendente", "aprovada", "recusada", "constructor", "invalid"]) {
    await store.list(status);
    assert.match(calls.at(-1).sql, /WHERE deleted_at IS NULL/);
    assert.deepEqual(calls.at(-1).params, ["pendente", "aprovada", "recusada"].includes(status) ? [status] : []);
  }
  const before = calls.length;
  assert.equal(await store.decide(id, "aprovada", null, { isApprover: false }), false);
  assert.equal(calls.length, before);
});

test("company name is escaped in UI and requester can withdraw their own pending card", async () => {
  const server = createApp({ config: { ...config, company_name: '<script>alert("x")</script>' }, env: { APP_SLUG: "compras-local" }, pool: {
    async query() { return { rows: [{ id, description: "Cadeira", status: "pendente", quantity: 1, estimated_value: 100, requester_email: headers["x-authentik-email"] }] }; },
  } });
  const response = await request(server, { headers });
  assert.equal(response.status, 200);
  assert.match(response.text, /&lt;script&gt;/);
  assert.doesNotMatch(response.text, /<script>/);
  assert.match(response.text, new RegExp(`/requests/${id}/delete`));
  assert.doesNotMatch(response.text, new RegExp(`/requests/${id}/decision`));
});

test("failed migrations close the pool and prevent listening", async (t) => {
  let listened = false, released = false, closed = false;
  t.mock.method(http.Server.prototype, "listen", () => { listened = true; });
  await assert.rejects(start({ env: { APP_SLUG: "compras-local" }, poolFactory: () => ({
    async connect() { return { async query() { throw new Error("database unavailable"); }, release() { released = true; } }; },
    async end() { closed = true; },
  }) }), /database unavailable/);
  assert.equal(listened, false);
  assert.equal(released, true);
  assert.equal(closed, true);
});
