// CRM PmotionIA: puente entre la app y la hoja de Google (Apps Script) + Google Calendar (iCal), Todoist y Metricool.
// Todas las claves viven en variables de entorno del servidor; la app solo habla con /api/crm/* (protegido por el PIN).
const fs = require("fs"), path = require("path");
const E = process.env;
const TZ = "Europe/Madrid";
// El guion (lleva precios) no va en el repositorio público: en Render vive en la variable GUION_B64; en local, en guion.md
const leeGuion = () => { if (E.GUION_B64) return Buffer.from(E.GUION_B64, "base64").toString("utf8"); try { return fs.readFileSync(path.join(__dirname, "guion.md"), "utf8"); } catch (e) { return ""; } };

/* ---------- hoja de Google ---------- */
async function hoja(body){
  if (!E.CRM_URL || !E.CRM_TOKEN) throw new Error("Falta CRM_URL / CRM_TOKEN en el servidor");
  const r = await fetch(E.CRM_URL, { method:"POST", body:JSON.stringify({ token:E.CRM_TOKEN, ...body }), redirect:"follow" });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Error del CRM");
  return j;
}
let cache = { t:0, rows:null };
async function leads(force){
  if (!force && cache.rows && Date.now() - cache.t < 60000) return cache.rows;
  const j = await hoja({ action:"get", sheet:"leads" });
  cache = { t:Date.now(), rows:j.rows || [] };
  return cache.rows;
}
// Resultados de llamada (igual que scripts/ventas.mjs, más «seguimiento»)
const RES = {
  "no-contesta": { Estado:"VOLVER A LLAMAR", nota:"no contesta" },
  "no-interesa": { Estado:"NO INTERESADO", nota:"no le interesa" },
  "volver":      { Estado:"CON FECHA", nota:"volver a llamar", accion:"Llamar " },
  "reunion":     { Estado:"REUNIÓN", nota:"demo agendada", accion:"Demo " },
  "interesado":  { Estado:"INTERESADO", nota:"interesado" },
  "seguimiento": { Estado:"SEGUIMIENTO", nota:"seguimiento", accion:"Seguimiento " },
  "descartar":   { Estado:"DESCARTADO", nota:"descartado" },
};
async function resultado(b){
  const r = RES[b.resultado], id = String(b.id || "");
  if (!r || !/^L-\d+$/.test(id)) throw new Error("Datos incorrectos");
  const detalle = String(b.detalle || "").slice(0, 300), firma = b.quien && b.quien !== "Pau" ? b.quien + ": " : "";
  const set = { Notas:`+${firma}${r.nota}${detalle ? ": " + detalle : ""}`, Estado:r.Estado };
  if (r.accion) set["Próxima acción"] = r.accion + detalle;
  await hoja({ action:"update", sheet:"leads", find:{ ID:id }, set });
  cache.t = 0;
  return { ok:true };
}
async function nota(b){
  const id = String(b.id || ""), t = String(b.texto || "").trim().slice(0, 500);
  if (!/^L-\d+$/.test(id) || !t) throw new Error("Datos incorrectos");
  await hoja({ action:"update", sheet:"leads", find:{ ID:id }, set:{ Notas:"+" + (b.quien && b.quien !== "Pau" ? b.quien + ": " : "") + t } });
  cache.t = 0;
  return { ok:true };
}

/* ---------- Google Calendar por su dirección secreta iCal ---------- */
const dosD = n => String(n).padStart(2, "0");
const madrid = d => { // Date → "AAAA-MM-DDTHH:MM" en hora de Madrid
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone:TZ, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
};
function fechaICS(v, params){
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  if (!m[4]) return { iso:`${m[1]}-${m[2]}-${m[3]}`, dia:true };
  if (m[7]) return { iso:madrid(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]))), dia:false };
  return { iso:`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, dia:false }; // con TZID (Europe/Madrid) o sin zona: hora local
}
function parseICS(txt, desde, hasta){
  const out = [];
  txt.replace(/\r?\n[ \t]/g, "").split("BEGIN:VEVENT").slice(1).forEach(b => {
    const get = k => { const m = b.match(new RegExp("^" + k + "((?:;[^:\\r\\n]*)?):(.*)$", "m")); return m ? { p:m[1], v:m[2].trim() } : null; };
    const s = get("DTSTART"); if (!s) return;
    const ini = fechaICS(s.v, s.p); if (!ini) return;
    const dia = ini.iso.slice(0, 10);
    if (dia < desde || dia > hasta) return;
    const fin = get("DTEND"), sum = get("SUMMARY"), loc = get("LOCATION");
    const un = t => (t || "").replace(/\\n/g, " ").replace(/\\([,;\\])/g, "$1");
    out.push({ titulo:un(sum && sum.v) || "(sin título)", inicio:ini.iso, fin:fin ? (fechaICS(fin.v, fin.p) || {}).iso : null, todoElDia:ini.dia, lugar:un(loc && loc.v) });
  });
  return out.sort((a, b) => a.inicio.localeCompare(b.inicio));
}
let calCache = { t:0, ev:null };
// Agenda y correo a través del Apps Script del CRM (cuenta de Google de Pau): sin claves extra
let resCache = { t:0, d:null };
async function resumenGoogle(){
  if (!resCache.d || Date.now() - resCache.t > 5 * 60000){ resCache = { t:Date.now(), d:await hoja({ action:"resumen" }) }; }
  return resCache.d;
}
async function correo(){
  try { const r = await resumenGoogle(); return { conectado:true, correos:r.correos || [] }; } catch (e) { return { conectado:false, correos:[], error:String(e.message || e) }; }
}
async function redes(){
  const r = await hoja({ action:"kv", clave:"redes" });
  return { datos:r.valor ? JSON.parse(r.valor) : null, actualizado:r.actualizado || null };
}
async function agenda(){
  if (!E.ICS_URL){ try { const r = await resumenGoogle(); return { conectado:true, eventos:r.eventos || [] }; } catch (e) { return { conectado:false, eventos:[] }; } }
  if (!calCache.ev || Date.now() - calCache.t > 5 * 60000){
    const txt = await (await fetch(E.ICS_URL)).text();
    const hoy = madrid(new Date()).slice(0, 10);
    const d = new Date(); d.setDate(d.getDate() + 14);
    calCache = { t:Date.now(), ev:parseICS(txt, hoy, madrid(d).slice(0, 10)) };
  }
  return { conectado:true, eventos:calCache.ev };
}

/* ---------- Todoist ---------- */
async function todoist(b){
  if (!E.TODOIST_TOKEN) throw new Error("Todoist no está conectado (falta TODOIST_TOKEN)");
  const content = String(b.content || "").slice(0, 300); if (!content) throw new Error("Tarea vacía");
  const r = await fetch("https://api.todoist.com/rest/v2/tasks", { method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer " + E.TODOIST_TOKEN },
    body:JSON.stringify({ content, due_string:String(b.due || "hoy"), due_lang:"es", priority:b.prioridad === 1 ? 4 : 1 }) });
  if (!r.ok) throw new Error("Todoist: " + r.status);
  const j = await r.json();
  return { ok:true, url:j.url };
}

async function tareasTodoist(){
  if (!E.TODOIST_TOKEN) return { conectado:false, tareas:[] };
  const r = await fetch("https://api.todoist.com/rest/v2/tasks?filter=" + encodeURIComponent("today | overdue | 7 days"), { headers:{ Authorization:"Bearer " + E.TODOIST_TOKEN } });
  if (!r.ok) throw new Error("Todoist: " + r.status);
  const j = await r.json();
  return { conectado:true, tareas:j.map(x => ({ id:x.id, texto:x.content, fecha:x.due ? (x.due.datetime || x.due.date) : "", prioridad:x.priority, url:x.url })).sort((a, b) => String(a.fecha || "9").localeCompare(String(b.fecha || "9"))) };
}
async function cerrarTodoist(b){
  if (!E.TODOIST_TOKEN) throw new Error("Todoist no está conectado");
  const id = String(b.id || "").replace(/[^\w]/g, ""); if (!id) throw new Error("Falta la tarea");
  const r = await fetch("https://api.todoist.com/rest/v2/tasks/" + id + "/close", { method:"POST", headers:{ Authorization:"Bearer " + E.TODOIST_TOKEN } });
  if (!r.ok) throw new Error("Todoist: " + r.status);
  return { ok:true };
}

/* ---------- Metricool: publicaciones programadas ---------- */
async function metricool(){
  if (!E.METRICOOL_TOKEN || !E.METRICOOL_USER || !E.METRICOOL_BLOG) return { conectado:false, posts:[] };
  const ini = madrid(new Date()).slice(0, 10), d = new Date(); d.setDate(d.getDate() + 14);
  const q = new URLSearchParams({ blogId:E.METRICOOL_BLOG, userId:E.METRICOOL_USER, start:ini + "T00:00:00", end:madrid(d).slice(0, 10) + "T23:59:59", timezone:TZ });
  const r = await fetch("https://app.metricool.com/api/v2/scheduler/posts?" + q, { headers:{ "X-Mc-Auth":E.METRICOOL_TOKEN } });
  if (!r.ok) throw new Error("Metricool: " + r.status);
  const j = await r.json();
  const posts = (j.data || j || []).map(p => ({ texto:String(p.text || "").slice(0, 140), fecha:(p.publicationDate && (p.publicationDate.dateTime || p.publicationDate)) || "", redes:(p.providers || []).map(x => x.network || x).join(", ") }));
  return { conectado:true, posts };
}

const conexiones = () => ({ hoja:!!(E.CRM_URL && E.CRM_TOKEN), calendar:!!E.ICS_URL || !!resCache.d, correo:!!resCache.d, todoist:!!E.TODOIST_TOKEN, metricool:!!(E.METRICOOL_TOKEN && E.METRICOOL_USER && E.METRICOOL_BLOG), guion:!!leeGuion() });

/* ---------- rutas ---------- */
async function handle(req, res, P, send, readBody){
  const ok = p => p.then(d => send(res, 200, d)).catch(e => send(res, 502, { error:String(e.message || e) }));
  if (req.method === "GET"){
    if (P === "/api/crm/leads") return ok(leads(new URL(req.url, "http://x").searchParams.has("fresh")).then(rows => ({ rows, hoy:madrid(new Date()).slice(0, 10) })));
    if (P === "/api/crm/agenda") return ok(agenda());
    if (P === "/api/crm/metricool") return ok(metricool());
    if (P === "/api/crm/tareas") return ok(tareasTodoist());
    if (P === "/api/crm/correo") return ok(correo());
    if (P === "/api/crm/redes") return ok(redes());
    if (P === "/api/crm/conexiones") return send(res, 200, conexiones());
    if (P === "/api/crm/guion-base") return send(res, 200, { texto:leeGuion() });
    return send(res, 404, { error:"no" });
  }
  return readBody(req, b => {
    if (!b) return send(res, 400, { error:"json" });
    if (b) b.quien = req.quien;
    if (P === "/api/crm/resultado") return ok(resultado(b));
    if (P === "/api/crm/nota") return ok(nota(b));
    if (P === "/api/crm/todoist") return ok(todoist(b));
    if (P === "/api/crm/todoist-cerrar") return ok(cerrarTodoist(b));
    send(res, 404, { error:"no" });
  });
}
module.exports = { handle };
