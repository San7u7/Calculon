/* Cassa comune — Cloudflare Worker.
   Binding KV richiesto:  CC
   Un record per chiave KV: grp:<GID>:rec:<RID>   /   grp:<GID>:meta          */

const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // senza I O 0 1

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS),
  });

function codice(n){
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  let s = "";
  for (let i = 0; i < n; i++) s += ALFA[a[i] % ALFA.length];
  return s;
}

/* --- 3.4, identica al client --- */
function merge(loc, rem){
  if (!loc) return rem;
  if (!rem) return loc;
  if (rem.version > loc.version) return rem;
  if (rem.version === loc.version && String(rem.deviceId) > String(loc.deviceId)) return rem;
  return loc;
}

/* --- 3.5, unione dei partecipanti --- */
function mergeMembers(locMeta, remMeta){
  const out = [], idx = {};
  const copia = (m) => { const c = { id: m.id, name: m.name, deleted: !!m.deleted }; if (m.pay) c.pay = m.pay; if (m.foto) c.foto = m.foto; return c; };
  for (const m of (locMeta.members || [])){ const c = copia(m); idx[m.id] = c; out.push(c); }
  const nomeDaRemoto = (remMeta.version || 0) > (locMeta.version || 0);
  for (const m of (remMeta.members || [])){
    const c = idx[m.id];
    if (!c){ const n = copia(m); idx[m.id] = n; out.push(n); }
    else {
      if (nomeDaRemoto){ c.name = m.name;
        if ("pay" in m){ if (m.pay) c.pay = m.pay; else delete c.pay; }
        if ("foto" in m){ if (m.foto) c.foto = m.foto; else delete c.foto; } }
      c.deleted = c.deleted || !!m.deleted;
    }
  }
  return out;
}

/* --- validazione, sezione 5 --- */
function valida(rec, members){
  const esiste = new Set((members || []).map(m => m.id));
  if (!rec || typeof rec !== "object") return "record assente";
  if (!Number.isInteger(rec.version) || rec.version < 1) return "version non valida";
  if (!Number.isInteger(rec.amountCents) || rec.amountCents <= 0) return "amountCents non valido";

  if (rec.kind === "expense"){
    if (!esiste.has(rec.payer)) return "payer inesistente";
    const mode = rec.split && rec.split.mode;
    if (["equal","shares","percent","exact"].indexOf(mode) < 0) return "mode sconosciuto";
    const parts = (rec.split && rec.split.parts) || {};
    const ids = Object.keys(parts);
    if (ids.length === 0) return "parts vuoto";
    for (const id of ids){
      if (!esiste.has(id)) return "partecipante inesistente: " + id;
      if (!Number.isInteger(parts[id]) || parts[id] < 0) return "parte non intera: " + id;
    }
    const somma = ids.reduce((s, id) => s + (mode === "equal" ? 1 : parts[id]), 0);
    if (mode === "percent" && somma !== 10000) return "percent: la somma non fa 10000";
    if (mode === "exact"   && somma !== rec.amountCents) return "exact: la somma non fa amountCents";
    if ((mode === "shares" || mode === "equal") && somma <= 0) return "somma delle parti <= 0";
    return null;
  }

  if (rec.kind === "payment"){
    if (!esiste.has(rec.from) || !esiste.has(rec.to)) return "from/to inesistente";
    if (rec.from === rec.to) return "from e to coincidono";
    return null;
  }

  return "kind sconosciuto";
}

const kMeta  = (gid) => "grp:" + gid + ":meta";
const kRec   = (gid, rid) => "grp:" + gid + ":rec:" + rid;
const kTocco = (gid) => "grp:" + gid + ":tocco";

const DIECI_GIORNI = 10 * 24 * 60 * 60;   // secondi: silenzio oltre questo, il gruppo scade

/* Ogni scrittura "tocca" il gruppo: rinnova per altri 10 giorni la sua sopravvivenza.
   Non cancella nulla subito: è una lapide con scadenza, letta al prossimo accesso. */
async function tocca(env, gid){
  await env.CC.put(kTocco(gid), "1", { expirationTtl: DIECI_GIORNI });
}

/* Se il tocco è scaduto (10 giorni senza scritture), il gruppo è considerato morto:
   lo spazziamo via del tutto e rispondiamo come se non fosse mai esistito. */
async function scadutoESpazzato(env, gid){
  const vivo = await env.CC.get(kTocco(gid));
  if (vivo) return false;
  const meta = await env.CC.get(kMeta(gid));
  if (!meta) return false;               // non è scaduto: semplicemente non esiste
  await cancellaGruppo(env, gid);
  return true;
}

async function cancellaGruppo(env, gid){
  await env.CC.delete(kMeta(gid));
  await env.CC.delete(kTocco(gid));
  let cursor;
  do {
    const l = await env.CC.list({ prefix: "grp:" + gid + ":rec:", cursor: cursor });
    for (const k of l.keys) await env.CC.delete(k.name);
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
}

async function leggiMeta(env, gid){ return await env.CC.get(kMeta(gid), "json"); }

async function leggiTutto(env, gid){
  const meta = await leggiMeta(env, gid);
  if (!meta) return null;
  const records = [];
  let cursor;
  do {
    const l = await env.CC.list({ prefix: "grp:" + gid + ":rec:", cursor: cursor });
    for (const k of l.keys){
      const r = await env.CC.get(k.name, "json");
      if (r) records.push(r);        // tombstone inclusi
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return { meta: meta, records: records };
}

export default {
  async fetch(req, env){
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);  // ["api","group",...]
    if (p[0] !== "api" || p[1] !== "group") return json({ error: "non trovato" }, 404);

    /* POST /api/group */
    if (req.method === "POST" && p.length === 2){
      let body;
      try { body = await req.json(); } catch(e){ return json({ error: "json non valido" }, 400); }
      const name = String(body && body.name || "").trim().slice(0, 60);
      const nomi = Array.isArray(body && body.members)
        ? body.members.map(n => String(n).trim().slice(0, 40)).filter(Boolean) : [];
      if (!name) return json({ error: "name mancante" }, 400);
      if (nomi.length < 1) return json({ error: "servono dei partecipanti" }, 400);

      let gid;
      for (let i = 0; i < 5; i++){
        gid = codice(6);
        if (!(await env.CC.get(kMeta(gid)))) break;
        gid = null;
      }
      if (!gid) return json({ error: "riprova" }, 503);

      const meta = {
        id: gid,
        name: name,
        version: 1,
        deviceId: "server",
        updatedAt: Date.now(),
        members: nomi.map(n => ({ id: "m_" + codice(4).toLowerCase(), name: n, deleted: false })),
      };
      await env.CC.put(kMeta(gid), JSON.stringify(meta));
      await tocca(env, gid);
      return json({ meta: meta, records: [] });
    }

    const gid = (p[2] || "").toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(gid)) return json({ error: "codice non valido" }, 400);
    if (await scadutoESpazzato(env, gid)) return json({ error: "gruppo inesistente" }, 404);

    /* DELETE /api/group/:gid — cancellazione definitiva, per tutti. Nessun ripensamento. */
    if (req.method === "DELETE" && p.length === 3){
      const meta = await leggiMeta(env, gid);
      if (!meta) return json({ error: "gruppo inesistente" }, 404);
      await cancellaGruppo(env, gid);
      return json({ ok: true });
    }

    /* GET /api/group/:gid */
    if (req.method === "GET" && p.length === 3){
      const stato = await leggiTutto(env, gid);
      if (!stato) return json({ error: "gruppo inesistente" }, 404);
      return json(stato);
    }

    /* PUT /api/group/:gid/meta */
    if (req.method === "PUT" && p.length === 4 && p[3] === "meta"){
      let entrante;
      try { entrante = await req.json(); } catch(e){ return json({ error: "json non valido" }, 400); }
      if (!Number.isInteger(entrante.version) || entrante.version < 1)
        return json({ error: "version non valida" }, 400);
      if (!Array.isArray(entrante.members)) return json({ error: "members mancante" }, 400);
      entrante.id = gid;

      const esistente = await leggiMeta(env, gid);
      if (!esistente) return json({ error: "gruppo inesistente" }, 404);
      if (merge(esistente, entrante) !== entrante) return json({ winner: esistente }, 409);

      // DUBBIO: la sezione 5 direbbe di scrivere la meta entrante così com'è, ma la regola 5
      // dice che i partecipanti si uniscono e non si sovrascrivono. Se scrivessimo la lista
      // entrante tale e quale, un client con una copia vecchia della meta ma version più alta
      // farebbe sparire dal server un partecipante aggiunto da un altro. Uniamo: conservativo,
      // e il client rifà comunque l'unione al pull successivo.
      entrante.members = mergeMembers(esistente, entrante);
      await env.CC.put(kMeta(gid), JSON.stringify(entrante));
      await tocca(env, gid);
      return json({ ok: true });
    }

    /* PUT /api/group/:gid/rec/:rid */
    if (req.method === "PUT" && p.length === 5 && p[3] === "rec"){
      const rid = p[4];
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(rid)) return json({ error: "id non valido" }, 400);

      let entrante;
      try { entrante = await req.json(); } catch(e){ return json({ error: "json non valido" }, 400); }
      if (entrante.id !== rid) return json({ error: "id incoerente" }, 400);

      const meta = await leggiMeta(env, gid);
      if (!meta) return json({ error: "gruppo inesistente" }, 404);

      const err = valida(entrante, meta.members);
      if (err) return json({ error: err }, 400);

      const esistente = await env.CC.get(kRec(gid, rid), "json");
      if (esistente && merge(esistente, entrante) !== entrante) return json({ winner: esistente }, 409);

      await env.CC.put(kRec(gid, rid), JSON.stringify(entrante));
      await tocca(env, gid);
      return json({ ok: true });
    }

    return json({ error: "non trovato" }, 404);
  },
};
