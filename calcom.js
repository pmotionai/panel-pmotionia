// Webhook de Cal.com (reuniones de la página /agenda): firma HMAC con CALCOM_SECRET y crea la tarea en Todoist.
const crypto = require("crypto");
const E = process.env;
const fecha = iso => new Intl.DateTimeFormat("es-ES", { timeZone:"Europe/Madrid", weekday:"long", day:"numeric", month:"long", hour:"2-digit", minute:"2-digit" }).format(new Date(iso));
function handle(req, res, send){
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 2e5) req.destroy(); });
  req.on("end", async () => {
    if (E.CALCOM_SECRET){
      const firma = crypto.createHmac("sha256", E.CALCOM_SECRET).update(raw).digest("hex");
      if (req.headers["x-cal-signature-256"] !== firma) return send(res, 401, { error:"firma" });
    }
    let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { error:"json" }); }
    const ev = b.triggerEvent, p = b.payload || {}, quien = (p.attendees || [])[0] || {};
    const negocio = (p.responses && (p.responses.negocio?.value || p.responses.notes?.value)) || "";
    const textos = { BOOKING_CREATED:"Reunión PmotionIA", BOOKING_RESCHEDULED:"Reunión movida", BOOKING_CANCELLED:"Reunión cancelada" };
    if (!textos[ev] || !p.startTime) return send(res, 200, { ok:true, ignorado:ev });
    const content = textos[ev] + " con " + (quien.name || "alguien") + (negocio ? " (" + negocio + ")" : "") + " · " + fecha(p.startTime) + (quien.email ? " · " + quien.email : "");
    try {
      const r = await require("./crm").todoist({ content, due:ev === "BOOKING_CANCELLED" ? "hoy" : p.startTime.slice(0, 16).replace("T", " "), prioridad:1 });
      send(res, 200, { ok:true, todoist:r.url });
    } catch (e) { console.error("calcom:", e.message); send(res, 200, { ok:false, error:e.message }); }
  });
}
module.exports = { handle };
