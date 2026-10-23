// Panel PmotionIA: feed de actividad de Claude, órdenes de Pau, leads y tareas. Avisos push al móvil (Web Push, sin librerías).
// Los datos viven en memoria: si el servidor gratuito se duerme, el móvil devuelve su copia de órdenes y Claude vuelve a cargar el resto.
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 10003;
const PUB = path.join(__dirname, "public");
const PIN = process.env.PANEL_PIN || "";
const RAFFI_PIN = process.env.RAFFI_PIN || "";
// Quién entra según el PIN: Pau lo ve todo; Raffi solo los leads, el guion y los resultados (sin correo, agenda ni tareas de Pau)
const quien = p => (PIN && p === PIN) ? "Pau" : (RAFFI_PIN && p === RAFFI_PIN) ? "Raffi" : "";
const VPUB = process.env.VAPID_PUBLIC || "", VPRIV = process.env.VAPID_PRIVATE || "";
const COLS = ["actividad", "ordenes", "leads", "tareas"];
let DB = { gen: Date.now().toString(36) }; COLS.forEach(c => DB[c] = {});
const now = () => Date.now();
const safeId = s => String(s || "").replace(/[^\w.-]/g, "").slice(0, 60);

let vKey = null;
if (VPUB && VPRIV){
  const raw = Buffer.from(VPUB, "base64url");
  vKey = crypto.createPrivateKey({ format:"jwk", key:{ kty:"EC", crv:"P-256", d:VPRIV, x:raw.subarray(1, 33).toString("base64url"), y:raw.subarray(33, 65).toString("base64url") } });
}
const subs = new Map();   // endpoint → { sub, msg }
function vapidJWT(aud){
  const h = Buffer.from(JSON.stringify({ typ:"JWT", alg:"ES256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ aud, exp:Math.floor(now()/1000) + 12*3600, sub:"mailto:contacto@pmotionia.com" })).toString("base64url");
  return `${h}.${p}.` + crypto.sign("sha256", Buffer.from(h + "." + p), { key:vKey, dsaEncoding:"ieee-p1363" }).toString("base64url");
}
function push(endpoint){
  if (!vKey) return;
  const u = new URL(endpoint);
  const req = https.request(u, { method:"POST", headers:{ TTL:"3600", Urgency:"high", "Content-Length":0, Authorization:`vapid t=${vapidJWT(u.origin)}, k=${VPUB}` } }, res => {
    if (res.statusCode === 404 || res.statusCode === 410) subs.delete(endpoint);
    res.resume();
  });
  req.on("error", () => {}); req.end();
}
function notify(msg){ for (const [ep, s] of subs){ s.msg = msg; push(ep); } }

const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type":type, "Cache-Control":"no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req, cb) => { let b = ""; req.on("data", c => { b += c; if (b.length > 4e5) req.destroy(); }); req.on("end", () => { try { cb(JSON.parse(b || "{}")); } catch (e) { cb(null); } }); };
const list = c => Object.entries(DB[c]).map(([id, d]) => ({ id, ...d })).sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, 200);
const state = () => ({ gen:DB.gen, actividad:list("actividad"), ordenes:list("ordenes"), leads:list("leads"), tareas:list("tareas") });

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x"), P = url.pathname, POST = req.method === "POST";
  if (P === "/api/vapid") return vKey ? send(res, 200, VPUB, "text/plain") : send(res, 503, "sin claves", "text/plain");
  if (P.startsWith("/api/")){
    const Q = quien(req.headers["x-pin"]);
    if (!Q) return send(res, 401, { error:"PIN incorrecto" });
    req.quien = Q;
    if (P === "/api/yo") return send(res, 200, { nombre:Q });
    if (Q !== "Pau") {
      if (P === "/api/state") return send(res, 200, { gen:DB.gen, actividad:[], ordenes:[], leads:[], tareas:[] });
      if (/^\/api\/crm\/(correo|agenda|tareas|metricool)$/.test(P)) return send(res, 200, { conectado:false, eventos:[], tareas:[], correos:[], posts:[] });
      if (!P.startsWith("/api/crm/") || /^\/api\/crm\/todoist/.test(P)) return send(res, 403, { error:"Solo Pau" });
    }
    if (P === "/api/state") return send(res, 200, state());
    if (P.startsWith("/api/crm/")) return require("./crm").handle(req, res, P, send, readBody);
    if (P.startsWith("/api/cerebro/")) { let c; try { c = require("./cerebro"); } catch (e) { return send(res, 503, { error:"El cerebro no está activado en este servidor" }); } return c.handle(req, res, P, send, readBody); }
    if (!POST) return send(res, 405, { error:"method" });
    return readBody(req, b => {
      if (!b) return send(res, 400, { error:"json" });
      // Pau: nueva orden
      if (P === "/api/orden"){
        const t = String(b.texto || "").trim().slice(0, 1000); if (!t) return send(res, 400, { error:"vacío" });
        const id = "o" + now().toString(36); DB.ordenes[id] = { texto:t, estado:"pendiente", ts:new Date().toISOString() };
        return send(res, 200, state());
      }
      // Pau: su móvil devuelve la copia de sus órdenes tras un reinicio del servidor
      if (P === "/api/restore"){
        if (b.gen !== DB.gen) (b.ordenes || []).slice(0, 200).forEach(o => { const id = safeId(o.id); if (id && !DB.ordenes[id]) DB.ordenes[id] = { texto:String(o.texto || "").slice(0, 1000), estado:o.estado || "pendiente", ts:o.ts, respuesta:o.respuesta }; });
        return send(res, 200, state());
      }
      // Claude: escribir/borrar documentos y avisar
      if (P === "/api/set"){
        if (!COLS.includes(b.col) || !safeId(b.id) || typeof b.data !== "object") return send(res, 400, { error:"args" });
        DB[b.col][safeId(b.id)] = { ...(b.merge ? DB[b.col][safeId(b.id)] : {}), ...b.data };
        if (b.col === "actividad" && b.push) notify({ title:"PmotionIA", body:String(b.data.texto || "").slice(0, 180), url:"/" });
        return send(res, 200, { ok:true });
      }
      if (P === "/api/del"){ if (COLS.includes(b.col)) delete DB[b.col][safeId(b.id)]; return send(res, 200, { ok:true }); }
      if (P === "/api/notify"){ notify({ title:String(b.title || "PmotionIA").slice(0, 60), body:String(b.body || "").slice(0, 180), url:"/" }); return send(res, 200, { ok:true, subs:subs.size }); }
      if (P === "/api/subscribe"){
        if (!b.sub || !/^https:\/\//.test(b.sub.endpoint || "")) return send(res, 400, { error:"sub" });
        const old = subs.get(b.sub.endpoint); subs.set(b.sub.endpoint, { sub:b.sub, msg:old ? old.msg : null });
        if (b.test){ subs.get(b.sub.endpoint).msg = { title:"Avisos activados", body:"Te avisaré de clips listos, respuestas y órdenes hechas.", url:"/" }; push(b.sub.endpoint); }
        return send(res, 200, { ok:true, subs:subs.size });
      }
      send(res, 404, { error:"no" });
    });
  }
  if (P === "/api/pushmsg-open") return send(res, 404, "", "text/plain");
  // el service worker pide el texto del aviso (el push llega vacío)
  if (P === "/pushmsg" && POST) return readBody(req, b => {
    const s = b && subs.get(b.endpoint);
    const m = (s && s.msg) || { title:"PmotionIA", body:"Hay novedades en el panel.", url:"/" };
    if (s) s.msg = null;
    send(res, 200, m);
  });
  const file = path.join(PUB, (P === "/" || P === "/raffi") ? "index.html" : path.normalize(decodeURIComponent(P)));
  if (!file.startsWith(PUB)) return send(res, 403, "no", "text/plain");
  const TYPES = { ".svg":"image/svg+xml", ".css":"text/css; charset=utf-8", ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".webmanifest":"application/manifest+json", ".png":"image/png" };
  fs.readFile(file, (e, d) => e ? send(res, 404, "No encontrado", "text/plain") : send(res, 200, d, TYPES[path.extname(file)] || "application/octet-stream"));
}).listen(PORT, () => console.log("Panel PmotionIA en :" + PORT + (vKey ? " · push activado" : " · push sin claves") + (PIN ? "" : " · SIN PIN")));

// Render gratis se duerme a los 15 min sin visitas: de 7:00 a 23:00 (Madrid) se visita a sí mismo cada 10 min
if (process.env.RENDER_EXTERNAL_URL) setInterval(() => {
  const h = +new Intl.DateTimeFormat("es-ES", { hour:"numeric", hour12:false, timeZone:"Europe/Madrid" }).format(new Date());
  if (h >= 7 && h < 23) fetch(process.env.RENDER_EXTERNAL_URL + "/manifest.webmanifest").catch(() => {});
}, 10 * 60 * 1000);
