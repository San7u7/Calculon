/* F4 · Passo 7E1 — Native E2EE Sync backend: outer-Worker router + SQLite-backed Durable Object.
   Il server vede SOLO header E2EE + ciphertext opaco. Mai decrypt, mai la AES key, mai il contenuto
   contabile. Il legacy /api/group/* + KV restano completamente separati (in worker.js, invariati). */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Max-Age": "86400",
};

// Limiti applicativi espliciti (riportati nel report).
export const LIMITS = {
  MAX_BODY_BYTES: 65536,      // 64 KiB: intera request/envelope
  MAX_CIPHERTEXT_B64: 49152,  // ~48 KiB base64url di ciphertext (~36 KiB binari)
  MAX_IV_B64: 24,             // iv 12 byte -> 16 char base64url; margine 24
  MAX_ID_LEN: 512,            // spaceId / recordId / deviceId
  RECORD_TYPES: { space: 1, member: 1, transaction: 1, shareRule: 1 },
};

function isB64url(s, maxLen){ return typeof s === "string" && s.length > 0 && s.length <= maxLen && /^[A-Za-z0-9_-]+$/.test(s); }
function b64urlToBytes(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s), b = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
function bytesToHex(buf){ var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s; }
async function sha256hex(bytes){ return bytesToHex(await crypto.subtle.digest("SHA-256", bytes)); }
function json(body, status){ return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, CORS) }); }

// COMPARATOR — identico al client (nativeSyncBoundary.nativeWinner). Nessun global clock.
export function nativeWinner(a, b){
  if (!a) return b; if (!b) return a;
  var va = a.version | 0, vb = b.version | 0;
  if (va !== vb) return va > vb ? a : b;
  var da = a.deleted === true, db = b.deleted === true;
  if (da !== db) return da ? a : b;
  return String(a.deviceId) > String(b.deviceId) ? a : b;
}

// Valida SOLO header + forma dell'envelope. Mai amount/allocations/payer/nomi/note/kind/status/parts.
export function validateEnvelope(env, route){
  if (!env || typeof env !== "object") return "envelope assente";
  if (env.protocolVersion !== 1) return "protocolVersion";
  if (typeof env.spaceId !== "string" || env.spaceId.length > LIMITS.MAX_ID_LEN) return "spaceId len";
  if (typeof env.recordId !== "string" || env.recordId.length > LIMITS.MAX_ID_LEN) return "recordId len";
  if (env.spaceId !== route.spaceId) return "spaceId mismatch";
  if (env.recordId !== route.recordId) return "recordId mismatch";
  if (env.recordType !== route.recordType) return "recordType mismatch";
  if (!LIMITS.RECORD_TYPES[env.recordType]) return "recordType non ammesso";
  if (!Number.isInteger(env.version) || env.version < 1) return "version";
  if (typeof env.deviceId !== "string" || env.deviceId === "" || env.deviceId.length > LIMITS.MAX_ID_LEN) return "deviceId";
  if (!Number.isInteger(env.keyVersion) || env.keyVersion < 1) return "keyVersion";
  if (typeof env.deleted !== "boolean") return "deleted";
  if (!isB64url(env.iv, LIMITS.MAX_IV_B64)) return "iv";
  if (!isB64url(env.ciphertext, LIMITS.MAX_CIPHERTEXT_B64)) return "ciphertext";
  return null;
}

function parsePath(pathname){
  var p = pathname.replace(/\/+$/, "").split("/").filter(Boolean);   // ["api","space",...]
  if (p[0] !== "api" || p[1] !== "space") return null;
  return { spaceId: p[2] ? decodeURIComponent(p[2]) : null,
           recordType: p[3] ? decodeURIComponent(p[3]) : null,
           recordId: p[4] ? decodeURIComponent(p[4]) : null, depth: p.length };
}

// OUTER WORKER: capability -> DO identity. Stesso spaceId + capability diversa => DO diverso.
// La capability NON viene mai persistita/loggata/rispedita: e' solo materiale di routing (via hash).
export async function handleSpaceRequest(request, env){
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  var url = new URL(request.url);
  var route = parsePath(url.pathname);
  if (!route || !route.spaceId) return json({ error: "route non valida" }, 404);
  var auth = request.headers.get("Authorization") || "";
  var m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m) return json({ error: "capability mancante" }, 401);
  var cap = m[1];
  if (!isB64url(cap, 64)) return json({ error: "capability malformata" }, 401);   // 32 byte -> 43 char base64url
  var capBytes = b64urlToBytes(cap);
  if (capBytes.length !== 32) return json({ error: "capability malformata" }, 401);
  var capHash = await sha256hex(capBytes);
  var doName = route.spaceId + ":" + capHash;   // conoscere spaceId da solo non da' accesso allo spazio reale
  var stub = env.SPACE_SYNC.get(env.SPACE_SYNC.idFromName(doName));
  return stub.fetch(request);
}

// DURABLE OBJECT (SQLite-backed). Stato: seq monotono + rec:<type>:<id> -> {envelope, seq}.
export class SpaceSyncDO {
  constructor(state, env){ this.state = state; this.env = env; }

  async fetch(request){
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    var url = new URL(request.url);
    var route = parsePath(url.pathname);
    if (!route || !route.spaceId) return json({ error: "route non valida" }, 404);
    if (request.method === "PUT" && route.recordType && route.recordId) return this.put(request, route);
    if (request.method === "GET" && route.depth === 3) return this.get(url, route);
    return json({ error: "non trovato" }, 404);
  }

  async put(request, route){
    if (!LIMITS.RECORD_TYPES[route.recordType]) return json({ error: "recordType non ammesso" }, 400);
    var raw = await request.text();
    if (raw.length > LIMITS.MAX_BODY_BYTES) return json({ error: "envelope troppo grande" }, 413);
    var env; try { env = JSON.parse(raw); } catch(e){ return json({ error: "json non valido" }, 400); }
    var err = validateEnvelope(env, route);
    if (err) return json({ error: "envelope invalido: " + err }, 400);

    var key = "rec:" + route.recordType + ":" + route.recordId, result;
    // Mutazione ATOMICA: read winner corrente -> nativeWinner -> eventualmente seq+1 -> write.
    await this.state.storage.transaction(async (txn) => {
      var cur = await txn.get(key);
      var seq = (await txn.get("seq")) || 0;
      var winner = cur ? nativeWinner(env, cur.envelope) : env;   // confronto SOLO header
      if (cur && winner !== env){ result = { accepted: false, winner: cur.envelope, seq: seq }; return; }   // stale/tie: nessun cambiamento, seq invariato
      var newSeq = seq + 1;
      await txn.put(key, { envelope: env, seq: newSeq });
      await txn.put("seq", newSeq);
      result = { accepted: true, winner: env, seq: newSeq };   // winner: esattamente un incremento seq
    });
    return json(result);
  }

  async get(url, route){
    var seq = (await this.state.storage.get("seq")) || 0;
    var sinceRaw = url.searchParams.get("since"), since = null;
    if (sinceRaw !== null){
      since = Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) return json({ error: "since non valido" }, 400);
      if (since > seq) return json({ error: "since-out-of-range", seq: seq }, 409);   // fail-closed esplicito
    }
    var map = await this.state.storage.list({ prefix: "rec:" });
    var rows = [];
    map.forEach(function(v, k){ if (since !== null && !(v.seq > since)) return; rows.push({ key: k, seq: v.seq, envelope: v.envelope }); });
    rows.sort(function(a, b){ return (a.seq - b.seq) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });   // ordine deterministico: seq poi record key
    return json({ seq: seq, records: rows.map(function(x){ return x.envelope; }) });
  }
}
