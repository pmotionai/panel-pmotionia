// Cerebro del CRM: un agente con Claude que conoce el negocio de Pau, lee sus datos y puede buscar en internet.
// Las acciones que cambian algo (estados, notas, tareas) NO se ejecutan aquí: se proponen y Pau las confirma en pantalla.
// Claves: ANTHROPIC_API_KEY (variable del servidor). Contexto privado del negocio: CONTEXTO_B64 (Render) o contexto.md (local, no se sube).
const fs = require("fs"), path = require("path");
const crm = require("./crm");
const E = process.env;
const MODELO = E.CEREBRO_MODELO || "claude-opus-5-5";
// Raffi y Rayan usan un modelo más barato y solo ven su sector, el guion y sus herramientas de llamada
const MODELO_EQUIPO = E.CEREBRO_MODELO_EQUIPO || "claude-haiku-5-5";
const esEquipo = q => q && q !== "Pau";

let cliente = null;
function claude(){
  if (!E.ANTHROPIC_API_KEY) throw new Error("El cerebro no está conectado: falta ANTHROPIC_API_KEY en el servidor");
  if (!cliente){ const A = require("@anthropic-ai/sdk"); cliente = new (A.default || A)(); }
  return cliente;
}
const disponible = () => !!E.ANTHROPIC_API_KEY;

function contexto(){
  if (E.CONTEXTO_B64) return Buffer.from(E.CONTEXTO_B64, "base64").toString("utf8");
  try { return fs.readFileSync(path.join(__dirname, "contexto.md"), "utf8"); } catch (e) { return ""; }
}

const SISTEMA = () => `Eres el cerebro de PmotionIA: el asistente personal de Pau dentro de su CRM. Pau tiene 17 años, estudia 2.º de Activitats Comercials en el INS Alella, hace prácticas en una gestoría (ARISVAL) y lleva dos negocios: PmotionIA (automatizaciones con IA para pymes: inmobiliarias, gestorías, fisios) y sírvelo (carta digital NFC y fidelización para bares y cafeterías).

Cómo respondes:
- En español de España, corto y directo, como un socio que conoce el negocio. Si te habla por voz, frases cortas que se puedan leer en voz alta, sin tablas ni listas largas.
- Antes de afirmar datos del CRM, de la agenda, del correo, de las tareas o de las redes, consúltalos con tus herramientas. No te inventes negocios, cifras ni fechas.
- Para cosas de fuera (un negocio en Google Maps, su web, una noticia, una norma) usa la búsqueda web y di de dónde sale.
- Para cambiar algo (resultado de una llamada, una nota, una tarea) usa las herramientas «proponer_*»: no se ejecuta hasta que Pau pulsa «Confirmar». Díselo en una frase.
- No puedes leer ni enviar WhatsApp, ni entrar en cuentas de Instagram o TikTok: solo lo público de la web y las estadísticas guardadas de Metricool.
- No menciones la edad de Pau a terceros ni en textos para clientes.

Lo que sabes del negocio (memoria, precios, guiones, cliente ideal):
${contexto() || "(sin contexto cargado)"}`;

const SECTOR_TXT = { Raffi:"inmobiliarias independientes del Maresme", Rayan:"gestorías y asesorías del Maresme" };
const SISTEMA_EQUIPO = q => `Eres el asistente de ${q} dentro del CRM de PmotionIA. ${q} es vendedor de PmotionIA: llama a ${SECTOR_TXT[q] || "negocios"} para conseguir reuniones de 15 minutos con Pau. No cierra ventas ni da precios.

Qué es PmotionIA: ayudamos a negocios pequeños a recuperar horas cada semana quitándoles lo repetitivo (contestar el WhatsApp, cuadrar visitas o citas, pedir papeles, recordar a quién llamar). Al cliente se le habla de lo que gana (tiempo, clientes, tranquilidad), nunca de tecnología ni de «agentes».

Cómo respondes:
- En español de España, corto y directo, como un compañero que sabe vender. Si te habla por voz, frases cortas que se puedan leer en voz alta.
- Si te pregunta qué decir, dale la frase exacta entre comillas, lista para decirla por teléfono.
- Antes de hablar de un negocio, consúltalo con ver_leads. No te inventes datos.
- Precio: nunca des cifras. Es personalizado y lo explica Pau en la reunión.
- Para guardar algo en una ficha usa proponer_nota o proponer_resultado (${q} lo confirma en pantalla). Si quiere decirle algo a Pau, usa avisar_pau.

Objeciones frecuentes:
- «Ya lo tenemos automatizado» → no discutir, preguntar: qué tienen automatizado exactamente, qué siguen haciendo a mano, del 1 al 10 cómo de contentos están; si es menos de 9, qué le falta para ser un 10 → eso es lo que enseña Pau en 15 minutos.
- «Preferimos el trato personal» → darle la razón: no lo quitamos; quitamos lo repetitivo para que tengan más tiempo para el trato personal. Ejemplo: quien escribe un domingo a las 11 de la noche prefiere respuesta y visita apuntada a esperar al lunes; el lunes le llaman igual.
- Siempre que digan que no, apuntar el motivo en la ficha.`;

/* ---------- herramientas ---------- */
const obj = (props, req) => ({ type:"object", properties:props, required:req || [], additionalProperties:false });
const HERR = [
  { name:"ver_leads", description:"Busca negocios en el CRM (hoja de leads). Filtra por texto (nombre, zona, tipo, notas) y/o estado. Devuelve como mucho 40 filas compactas con ID, negocio, tipo, zona, teléfono, estado, próxima acción y notas recientes.",
    input_schema:obj({ texto:{ type:"string", description:"Texto a buscar; vacío para todos" }, estado:{ type:"string", description:"Estado exacto (NUEVO, POR LLAMAR, CON FECHA, REUNIÓN, INTERESADO, SEGUIMIENTO, NO INTERESADO…) o vacío" } }, ["texto", "estado"]), strict:true },
  { name:"ver_agenda", description:"Agenda de Google Calendar de hoy y los próximos días.", input_schema:obj({}), strict:true },
  { name:"ver_correo", description:"Correos sin leer de Gmail (remitente y asunto).", input_schema:obj({}), strict:true },
  { name:"ver_tareas", description:"Tareas pendientes de Todoist.", input_schema:obj({}), strict:true },
  { name:"ver_redes", description:"Estadísticas guardadas de Instagram y TikTok (Metricool) y contenido programado.", input_schema:obj({}), strict:true },
  { name:"ver_guion", description:"Guion de llamada actual de PmotionIA (apertura, gancho, objeciones, precios orientativos).", input_schema:obj({}), strict:true },
  { name:"proponer_resultado", description:"Propone registrar el resultado de una llamada en el CRM. Pau lo confirma en pantalla.",
    input_schema:obj({ id:{ type:"string", description:"ID del lead, p. ej. L-215" }, resultado:{ type:"string", enum:["no-contesta", "no-interesa", "volver", "reunion", "interesado", "seguimiento", "descartar"] }, detalle:{ type:"string", description:"Detalle breve: fecha y hora si es volver o reunión, o qué dijo" } }, ["id", "resultado", "detalle"]), strict:true },
  { name:"proponer_nota", description:"Propone añadir una nota a un negocio del CRM. Pau la confirma en pantalla.",
    input_schema:obj({ id:{ type:"string" }, texto:{ type:"string" } }, ["id", "texto"]), strict:true },
  { name:"proponer_tarea", description:"Propone crear una tarea en Todoist. Pau la confirma en pantalla.",
    input_schema:obj({ texto:{ type:"string" }, cuando:{ type:"string", description:"Fecha en lenguaje natural en español: hoy, mañana, lunes 10:15, 27 oct…" } }, ["texto", "cuando"]), strict:true },
  { type:"web_search_20260209", name:"web_search", max_uses:5, user_location:{ type:"approximate", city:"Mataró", region:"Cataluña", country:"ES", timezone:"Europe/Madrid" } },
  { type:"web_fetch_20260209", name:"web_fetch", max_uses:5 },
];

const HERR_EQUIPO = [
  HERR.find(h => h.name === "ver_leads"), HERR.find(h => h.name === "ver_guion"),
  HERR.find(h => h.name === "proponer_resultado"), HERR.find(h => h.name === "proponer_nota"),
  { name:"avisar_pau", description:"Envía un recado a Pau (le llega un aviso al móvil). Úsalo cuando el vendedor quiera contarle algo: un interesado, una duda, un problema.",
    input_schema:obj({ texto:{ type:"string" } }, ["texto"]), strict:true },
  { type:"web_search_20260209", name:"web_search", max_uses:3, user_location:{ type:"approximate", city:"Mataró", region:"Cataluña", country:"ES", timezone:"Europe/Madrid" } },
];
const corta = (s, n) => String(s || "").replace(/\s+/g, " ").slice(-n);
async function ejecutar(nombre, inp, propuestas, ctx){
  switch (nombre){
    case "ver_leads": {
      const t = String(inp.texto || "").toLowerCase(), st = String(inp.estado || "").toUpperCase();
      const filas = crm.deQuien(await crm.leads(), ctx.quien).filter(l => (!st || String(l.Estado).toUpperCase() === st) && (!t || [l.Negocio, l.Zona, l.Tipo, l.Notas, l["Próxima acción"]].join(" ").toLowerCase().includes(t)));
      return { total:filas.length, filas:filas.slice(0, 40).map(l => ({ id:l.ID, negocio:l.Negocio, tipo:l.Tipo, zona:l.Zona, tel:l.Teléfono, estado:l.Estado, proxima:l["Próxima acción"], fecha:l["Fecha próxima acción"], notas:corta(l.Notas, 220) })) };
    }
    case "avisar_pau": { if (!ctx.avisarPau) throw new Error("Recados no disponibles"); ctx.avisarPau(ctx.quien, inp.texto); return { ok:true, enviado:"Pau recibirá el recado en el móvil" }; }
    case "ver_agenda": return crm.agenda();
    case "ver_correo": return crm.correo();
    case "ver_tareas": return crm.tareasTodoist();
    case "ver_redes": { const [r, m] = await Promise.allSettled([crm.redes(), crm.metricool()]); return { redes:r.value || String(r.reason), programado:m.value || String(m.reason) }; }
    case "ver_guion": return { guion:crm.leeGuion().slice(0, 12000) };
    case "proponer_resultado": case "proponer_nota": case "proponer_tarea": {
      const p = { id:"p" + Date.now().toString(36) + propuestas.length, tipo:nombre.replace("proponer_", ""), datos:inp };
      propuestas.push(p);
      return { estado:"pendiente de confirmar en pantalla", propuesta:p.id };
    }
  }
  throw new Error("Herramienta desconocida: " + nombre);
}

/* ---------- conversación ---------- */
async function preguntar(b, extras){
  const q = b.quien || "Pau", equipo = esEquipo(q), ctx = { quien:q, avisarPau:extras && extras.avisarPau };
  const historial = (Array.isArray(b.historial) ? b.historial : []).slice(-16)
    .filter(m => (m.rol === "u" || m.rol === "a") && String(m.texto || "").trim())
    .map(m => ({ role:m.rol === "u" ? "user" : "assistant", content:String(m.texto).slice(0, 4000) }));
  while (historial.length && historial[0].role !== "user") historial.shift();
  const hoy = new Intl.DateTimeFormat("es-ES", { timeZone:"Europe/Madrid", dateStyle:"full", timeStyle:"short" }).format(new Date());
  const pregunta = String(b.pregunta || "").slice(0, 4000);
  const messages = [...historial, { role:"user", content:`[Ahora: ${hoy}${b.lead ? ` · ficha abierta: ${b.lead}` : ""}${b.voz ? " · me hablas por voz" : ""}]\n${pregunta}` }];
  const propuestas = [];
  const fuentes = [];
  for (let vuelta = 0; vuelta < 10; vuelta++){
    const r = await claude().beta.messages.create({
      model:equipo ? MODELO_EQUIPO : MODELO, max_tokens:equipo ? 4000 : 16000,
      betas:["server-side-fallback-2026-07-01"], fallbacks:"default",
      ...(equipo ? {} : { output_config:{ effort:"medium" } }),
      system:[{ type:"text", text:equipo ? SISTEMA_EQUIPO(q) : SISTEMA(), cache_control:{ type:"ephemeral" } }],
      tools:equipo ? HERR_EQUIPO : HERR, messages,
    });
    for (const c of r.content) if (c.type === "web_search_tool_result" && Array.isArray(c.content)) c.content.forEach(x => x.url && fuentes.push({ titulo:x.title, url:x.url }));
    if (r.stop_reason === "refusal") return { texto:"No puedo ayudarte con eso.", propuestas, fuentes };
    messages.push({ role:"assistant", content:r.content });
    if (r.stop_reason === "pause_turn") continue;
    const usos = r.content.filter(c => c.type === "tool_use");
    if (r.stop_reason !== "tool_use" || !usos.length){
      const texto = r.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
      return { texto:texto || "Hecho.", propuestas, fuentes:fuentes.slice(0, 5) };
    }
    const resultados = await Promise.all(usos.map(async u => {
      try { return { type:"tool_result", tool_use_id:u.id, content:JSON.stringify(await ejecutar(u.name, u.input || {}, propuestas, ctx)).slice(0, 30000) }; }
      catch (e) { return { type:"tool_result", tool_use_id:u.id, is_error:true, content:String(e.message || e) }; }
    }));
    messages.push({ role:"user", content:resultados });
  }
  return { texto:"Me he liado con demasiados pasos. ¿Me lo preguntas de otra forma?", propuestas, fuentes };
}

// Pau confirma una propuesta en pantalla: aquí sí se ejecuta
async function confirmar(b){
  const d = b.datos || {};
  if (b.tipo === "resultado") return crm.resultado({ id:d.id, resultado:d.resultado, detalle:d.detalle, quien:b.quien });
  if (b.tipo === "nota") return crm.nota({ id:d.id, texto:d.texto, quien:b.quien });
  if (esEquipo(b.quien)) throw new Error("Solo Pau");
  if (b.tipo === "tarea") return crm.todoist({ content:d.texto, due:d.cuando });
  throw new Error("Propuesta desconocida");
}

async function handle(req, res, P, send, readBody, extras){
  if (P === "/api/cerebro/estado") return send(res, 200, { disponible:disponible(), modelo:MODELO, contexto:!!contexto() });
  if (req.method !== "POST") return send(res, 405, { error:"method" });
  readBody(req, b => {
    if (!b) return send(res, 400, { error:"json" });
    b.quien = req.quien;
    const p = P === "/api/cerebro/preguntar" ? preguntar(b, extras) : P === "/api/cerebro/confirmar" ? confirmar(b) : null;
    if (!p) return send(res, 404, { error:"no" });
    p.then(d => send(res, 200, d)).catch(e => send(res, 502, { error:String(e.message || e) }));
  });
}
module.exports = { handle, disponible };
