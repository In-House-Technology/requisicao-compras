import crypto from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPool, migrateDatabase } from "./migrate.js";
import { isApprover, requestStore, STATUS, UUID_PATTERN } from "./requests.js";

export function createApp({ pool, config, env = process.env }) {
  const slug = env.APP_SLUG;
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) throw new Error("Defina APP_SLUG com o slug escolhido na instalação (3 a 32 caracteres).");
  const store = requestStore(pool);
  const listRequests = (status) => store.list(status);

  // ---------- Pessoa ----------
  function person(req) {
    const email = String(req.headers["x-authentik-email"] || env.LOCAL_AUTH_MOCK_EMAIL || "").toLowerCase();
    const name = String(req.headers["x-authentik-name"] || env.LOCAL_AUTH_MOCK_NAME || email);
    const groups = String(req.headers["x-authentik-groups"] || env.LOCAL_AUTH_MOCK_GROUPS || "")
      .split(/[|,]/).map((g) => g.trim()).filter(Boolean);
    return email ? { email, name, groups, isApprover: isApprover(email, groups, config) } : null;
  }

  // ---------- Utilidades ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const brl = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const qty = (v) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const when = (d) => (d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "");

  // Aceita "1.234,56", "1234,56" e "1234.56".
  function parseNumber(raw) {
    let s = String(raw ?? "").replace(/[R$\s]/g, "");
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return s !== "" && Number.isFinite(n) ? n : NaN;
  }

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function redirect(res, location) {
    res.writeHead(303, { location });
    res.end();
  }

  async function readRaw(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new Error("body too large");
    }
    return raw;
  }

  // Formulários só da própria origem (proteção simples contra CSRF).
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // ---------- Página ----------
  const DONE_LIMIT = 30; // cartões mostrados nas colunas Aprovada e Recusada

  function page(me, allRows, mine, flash, openForm) {
    const canDecide = (r) => me.isApprover && r.status === "pendente" && r.requester_email !== me.email;
    const rows = mine ? allRows.filter((r) => r.requester_email === me.email || canDecide(r)) : allRows;

    // Resumo do topo: o que é meu para decidir, o que é meu esperando, totais.
    const pend = allRows.filter((r) => r.status === "pendente");
    const toDecide = pend.filter(canDecide);
    const myWaiting = pend.filter((r) => r.requester_email === me.email);
    const othersWaiting = pend.filter((r) => !canDecide(r) && r.requester_email !== me.email);
    const sum = (list) => brl(list.reduce((s, r) => s + Number(r.estimated_value), 0));
    const tile = (cls, n, label, sub) => `<div class="tile ${cls}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const summary = `<section class="summary">
      ${me.isApprover ? tile(toDecide.length ? "hot" : "", toDecide.length, "para você decidir", toDecide.length ? sum(toDecide) : "nada esperando você") : ""}
      ${tile("", myWaiting.length, "seus pedidos aguardando", myWaiting.length ? sum(myWaiting) : "")}
      ${tile("", othersWaiting.length, me.isApprover ? "aguardando outro gestor" : "outros pendentes", "")}
    </section>`;

    const card = (r) => {
      const decision = r.status === "pendente"
        ? (canDecide(r)
          ? `<form class="decide" method="post" action="/requests/${r.id}/decision">
               <input name="note" maxlength="500" placeholder="Comentário (opcional)">
               <div class="btns"><button name="action" value="aprovar" class="ok">Aprovar</button>
               <button name="action" value="recusar" class="no">Recusar</button></div>
             </form>`
          : `<p class="muted">${r.requester_email === me.email ? (me.isApprover ? "Aguardando outro gestor." : "Aguardando o gestor.") : "Aguardando o gestor."}</p>`)
        : `<p class="muted">Por ${esc(r.decided_by_name || r.decided_by)} em ${when(r.decided_at)}${r.decision_note ? ` — “${esc(r.decision_note)}”` : ""}</p>`;
      const tag = canDecide(r) ? `<span class="tag hot">Você decide</span>` : r.requester_email === me.email ? `<span class="tag">Seu pedido</span>` : "";
      return `<li class="card${canDecide(r) ? " mine" : ""}">
        ${tag}
        <strong>#${esc(r.id.slice(0, 8))} · ${esc(r.description)}</strong>
        <div class="meta">${qty(r.quantity)} un. · <b>${brl(r.estimated_value)}</b></div>
        <div class="meta">${esc(r.requester_name || r.requester_email)} · ${when(r.created_at)}</div>
        <details class="just"><summary>Justificativa</summary><p>${esc(r.justification)}</p></details>
        ${decision}
        ${r.status === "pendente" && r.requester_email === me.email ? `<form method="post" action="/requests/${r.id}/delete"><button class="no">Retirar pedido</button></form>` : ""}
      </li>`;
    };

    const column = (status) => {
      let list = rows.filter((r) => r.status === status);
      if (status === "pendente") list.sort((a, b) => canDecide(b) - canDecide(a)); // os meus para decidir primeiro
      const total = list.length;
      if (status !== "pendente") list = list.slice(0, DONE_LIMIT);
      return `<section class="col">
        <h2><span class="dot ${status}"></span>${STATUS[status]}<span class="count">${total}</span></h2>
        <ul>${list.map(card).join("") || `<li class="empty">Nada aqui.</li>`}</ul>
        ${total > list.length ? `<p class="muted more">Mostrando as ${list.length} mais recentes de ${total}.</p>` : ""}
      </section>`;
    };

    const tabs = `<a class="tab${mine ? "" : " on"}" href="/">Todas</a><a class="tab${mine ? " on" : ""}" href="/?mine=1">Só as minhas</a>`;

    return `<!doctype html>
  <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Requisição de compras · ${esc(config.company_name)}</title>
  <style>
  :root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e3e1db;--acc:#1f4fd1;--ok:#1b7f45;--no:#b3261e;--warn:#9a6700}
  @media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1f1f1d;--ink:#eceae4;--muted:#a19f98;--line:#33322f;--acc:#7da0ff;--ok:#5cc98a;--no:#ff8a80;--warn:#e0b44c}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0}header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .who{color:var(--muted);font-size:13px}.flash{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--acc);padding:10px 12px;border-radius:8px;margin-bottom:16px}
  details.newreq{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:16px}details.newreq>summary{cursor:pointer;padding:12px 16px;font-weight:600;color:var(--acc)}
  form.new{padding:0 16px 16px;display:grid;gap:10px;grid-template-columns:1fr 1fr}
  form.new .full{grid-column:1/-1}label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
  input,textarea{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}textarea{min-height:70px;resize:vertical}
  button{font:inherit;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;color:#fff;background:var(--acc)}button.ok{background:var(--ok)}button.no{background:var(--no)}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.tab{padding:6px 12px;border-radius:999px;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:13px}.tab.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:grid;gap:2px}.tile b{font-size:28px;line-height:1}.tile span{font-size:13px}.tile small{color:var(--muted);font-size:12px}
  .tile.hot{border-color:var(--warn);box-shadow:inset 4px 0 0 var(--warn)}
  .board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
  .col{background:color-mix(in srgb,var(--line) 35%,transparent);border-radius:12px;padding:10px}
  .col h2{font-size:14px;margin:4px 4px 10px;display:flex;align-items:center;gap:8px}.count{margin-left:auto;color:var(--muted);font-weight:400}
  .dot{width:9px;height:9px;border-radius:50%;background:currentColor}
  ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:4px}
  .card.mine{border-color:var(--warn)}.tag{justify-self:start;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--line);color:var(--ink)}.tag.hot{background:var(--warn);color:var(--bg)}
  .meta,.muted{color:var(--muted);font-size:13px}.meta b{color:var(--ink)}.muted{margin:4px 0 0}.more{text-align:center}
  .just summary{cursor:pointer;color:var(--muted);font-size:13px}.just p{margin:6px 0 0;white-space:pre-wrap;font-size:14px}
  .pendente{color:var(--warn)}.aprovada{color:var(--ok)}.recusada{color:var(--no)}
  .decide{display:grid;gap:6px;margin-top:6px}.btns{display:flex;gap:6px}.btns button{flex:1}.empty{color:var(--muted);padding:16px;text-align:center;font-size:13px}
  @media (max-width:820px){.board{grid-template-columns:1fr}}
  @media (max-width:560px){form.new{grid-template-columns:1fr}}
  </style></head><body><main>
  <header><div><h1>Requisição de compras</h1><span class="who">${esc(config.company_name)}</span></div><span class="who">${esc(me.name)}${me.isApprover ? " · gestor" : ""}</span></header>
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
  ${summary}
  <details class="newreq"${openForm ? " open" : ""}><summary>+ Nova requisição</summary>
  <form class="new" method="post" action="/requests">
    <label class="full">Descrição do item<input name="description" required maxlength="300"></label>
    <label>Quantidade<input name="quantity" required inputmode="decimal" placeholder="1"></label>
    <label>Valor estimado total (R$)<input name="estimated_value" required inputmode="decimal" placeholder="0,00"></label>
    <label class="full">Justificativa<textarea name="justification" required maxlength="2000"></textarea></label>
    <div class="full"><button>Enviar requisição</button></div>
  </form></details>
  <nav class="tabs">${tabs}</nav>
  <div class="board">${Object.keys(STATUS).map(column).join("")}</div>
  </main></body></html>`;
  }

  const FLASH = {
    criada: "Requisição enviada. O gestor vai aprovar ou recusar.",
    aprovada: "Requisição aprovada.",
    recusada: "Requisição recusada.",
    invalida: "Preencha descrição, quantidade (maior que zero), valor estimado e justificativa.",
    sem_permissao: "Só gestores aprovam ou recusam, e não o próprio pedido.",
    ja_decidida: "Essa requisição já tinha sido decidida.",
    retirada: "Requisição retirada.",
    nao_retirada: "Só é possível retirar seus próprios pedidos pendentes.",
  };

  // ---------- MCP (ferramentas para agentes) ----------
  const MCP = {
    issuer: env.IHC_MCP_ISSUER || "",
    jwksUrl: env.IHC_MCP_JWKS_URL || "",
    audience: env.IHC_MCP_AUDIENCE || `${slug}.mcp`,
    readScope: `${slug}.read`,
  };

  const TOOLS = {
    list_requests: {
      scope: MCP.readScope,
      access: "read",
      description: "Lista as requisições de compra com status (pendente, aprovada, recusada), solicitante, valor e decisão.",
      input_schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["pendente", "aprovada", "recusada"] } },
        additionalProperties: false,
      },
      run: async (_actor, args) => (await listRequests(args.status)).map((r) => ({
        id: r.id, description: r.description, quantity: Number(r.quantity), estimated_value: Number(r.estimated_value),
        justification: r.justification, requester: r.requester_email, status: r.status,
        decided_by: r.decided_by, decision_note: r.decision_note, decided_at: r.decided_at, created_at: r.created_at,
      })),
    },
  };

  let jwks = { keys: [], fetchedAt: 0 };
  async function gatewayKeys(kid) {
    const stale = Date.now() - jwks.fetchedAt > 5 * 60_000;
    const unknown = kid && !jwks.keys.some((key) => key.kid === kid) && Date.now() - jwks.fetchedAt > 30_000;
    if (stale || unknown) {
      const response = await fetch(MCP.jwksUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
      jwks = { keys: (await response.json()).keys || [], fetchedAt: Date.now() };
    }
    return jwks.keys;
  }

  async function verifyActor(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
    if (!match || !MCP.issuer || !MCP.jwksUrl) return null;
    try {
      const [h, p, s] = match[1].split(".");
      const header = JSON.parse(Buffer.from(h, "base64url"));
      const claims = JSON.parse(Buffer.from(p, "base64url"));
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;
      const jwk = (await gatewayKeys(header.kid)).find((key) => key.kid === header.kid);
      if (!jwk) return null;
      const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
      if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return null;
      const now = Math.floor(Date.now() / 1000);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== MCP.issuer || !aud.includes(MCP.audience) || typeof claims.exp !== "number" || !(claims.exp + 30 > now) ||
          typeof claims.email !== "string" || !claims.email || !Array.isArray(claims.groups)) return null;
      return { email: claims.email || claims.sub, groups: claims.groups || [], scopes: String(claims.scope || "").split(" ").filter(Boolean) };
    } catch {
      return null;
    }
  }

  async function mcp(req, res, path) {
    const actor = await verifyActor(req);
    if (!actor) return json(res, 401, { error: { code: "invalid_actor_token", message: "É necessário um JWT válido do gateway MCP da nuvem." } });
    const allowed = Object.entries(TOOLS).filter(([, tool]) => actor.scopes.includes(tool.scope));
    if (req.method === "GET" && path === "/mcp/tools") {
      if (allowed.length === 0) return json(res, 403, { error: { code: "tool_access_denied", message: `Sem escopo de acesso a ${slug}.` } });
      return json(res, 200, { tools: allowed.map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.input_schema, access: tool.access })) });
    }
    const call = path.match(/^\/mcp\/tools\/([A-Za-z0-9_-]+)\/execute$/);
    if (req.method === "POST" && call) {
      const tool = Object.hasOwn(TOOLS, call[1]) ? TOOLS[call[1]] : null;
      if (!tool) return json(res, 404, { error: { code: "tool_not_found", message: `Ferramenta ${call[1]} não encontrada.` } });
      if (!actor.scopes.includes(tool.scope)) return json(res, 403, { error: { code: "tool_access_denied", message: `A ferramenta exige o escopo ${tool.scope}.` } });
      const raw = await readRaw(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: { code: "invalid_arguments", message: "Envie um objeto JSON com os argumentos da consulta." } });
      }
      const args = body.arguments ?? {};
      if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((key) => key !== "status") ||
          (Object.hasOwn(args, "status") && !Object.hasOwn(STATUS, args.status))) {
        return json(res, 400, { error: { code: "invalid_arguments", message: "Informe somente status: pendente, aprovada ou recusada." } });
      }
      return json(res, 200, { result: await tool.run(actor, args) });
    }
    return json(res, 404, { error: { code: "not_found" } });
  }

  // ---------- Rotas ----------
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://local");
      const path = url.pathname;
      if (path === "/health") {
        await pool.query("SELECT 1");
        return json(res, 200, { ok: true, service: slug, db: true });
      }
      if (path.startsWith("/mcp/")) return await mcp(req, res, path);

      const me = person(req);
      if (!me) return json(res, 401, { error: "Entre com sua conta da empresa." });

      if (path === "/me") return json(res, 200, me);

      if (req.method === "GET" && path === "/") {
        const msg = url.searchParams.get("msg");
        const rows = await listRequests();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(page(me, rows, url.searchParams.get("mine") === "1", FLASH[msg] || "", msg === "invalida" || rows.length === 0));
      }

      if (req.method === "GET" && path === "/api/requests") {
        return json(res, 200, { requests: await listRequests(url.searchParams.get("status")) });
      }

      if (req.method === "POST" && path === "/requests") {
        if (!sameOrigin(req)) return json(res, 403, { error: "Envie o formulário a partir do próprio app." });
        const f = new URLSearchParams(await readRaw(req));
        const description = (f.get("description") || "").trim().slice(0, 300);
        const justification = (f.get("justification") || "").trim().slice(0, 2000);
        const quantity = parseNumber(f.get("quantity"));
        const value = parseNumber(f.get("estimated_value"));
        if (!description || !justification || !(quantity > 0) || !(value >= 0)) return redirect(res, "/?msg=invalida");
        await store.create({ description, quantity, value, justification }, me);
        return redirect(res, "/?msg=criada");
      }

      const withdrawal = path.match(new RegExp(`^/requests/(${UUID_PATTERN})/delete$`));
      if (req.method === "POST" && withdrawal) {
        if (!sameOrigin(req)) return json(res, 403, { error: "Envie o formulário a partir do próprio app." });
        const deleted = await store.softDelete(withdrawal[1], me);
        return redirect(res, deleted ? "/?msg=retirada" : "/?msg=nao_retirada");
      }

      const decision = path.match(new RegExp(`^/requests/(${UUID_PATTERN})/decision$`));
      if (req.method === "POST" && decision) {
        if (!sameOrigin(req)) return json(res, 403, { error: "Envie o formulário a partir do próprio app." });
        const f = new URLSearchParams(await readRaw(req));
        const action = f.get("action");
        const status = action === "aprovar" ? "aprovada" : action === "recusar" ? "recusada" : null;
        if (!status || !me.isApprover) return redirect(res, "/?msg=sem_permissao");
        const decided = await store.decide(decision[1], status, (f.get("note") || "").trim().slice(0, 500) || null, me);
        return redirect(res, decided ? `/?msg=${status}` : "/?msg=ja_decidida");
      }

      return json(res, 404, { error: "Página não encontrada." });
    } catch (error) {
      console.error(error);
      return json(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? "JSON inválido." : "Não foi possível concluir a operação." });
    }
  });

}

export async function start({ env = process.env, directory, poolFactory = createPool } = {}) {
  // Invalid configuration or failed migrations must prevent the HTTP listener.
  const config = await loadConfig(directory);
  const pool = poolFactory(env);
  try {
    const server = createApp({ pool, config, env });
    await migrateDatabase(pool);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(env.PORT || 8080), resolve);
    });
    return { server, pool };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, pool } = await start();
    console.log(`App ${process.env.APP_SLUG} iniciado na porta ${server.address().port}.`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => pool.end()));
  } catch (error) {
    console.error(`Não foi possível iniciar: ${error.message}`);
    process.exitCode = 1;
  }
}
