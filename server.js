const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = "2.1.0";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.get("/projet-vendeur", (req, res) => res.sendFile(path.join(__dirname, "public", "projet-vendeur.html")));
app.get("/facebook", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/projet-vendeur${qs}`);
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
}) : null;

const memory = { prospects: new Map(), leads: new Map() };
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const cleanEmail = v => String(v ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"").trim().slice(0,180);
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(v));
const toBoolean = v => v === true || v === "true" || v === 1 || v === "1";
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function sendLeadConfirmationEmail(lead) {
  if (!lead.email) return { sent: false, reason: "no-email" };
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM || "").trim();
  if (!apiKey || !from) {
    console.warn("JML email confirmation non envoyée: RESEND_API_KEY ou RESEND_FROM manquant.");
    return { sent: false, reason: "email-provider-not-configured" };
  }
  const firstName = clean(lead.name, 120).split(/\s+/)[0] || "Bonjour";
  const subject = "Votre demande concernant votre projet immobilier";
  const text = "Bonjour " + firstName + ",\n\n" +
    "Nous avons bien reçu votre demande concernant votre projet immobilier dans les Ardennes.\n\n" +
    "Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.\n\n" +
    "À bientôt,\nJML Immobilier\nVotre projet, notre engagement";
  const safeName = firstName.replace(/[&<>"]/g, "");
  const html = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#f5f1e8;font-family:Arial,sans-serif;color:#26352f\">" +
    "<div style=\"max-width:620px;margin:30px auto;padding:0 16px\">" +
    "<div style=\"background:#173b32;padding:22px 24px;border-radius:12px 12px 0 0;color:#fff\"><div style=\"font-size:22px;font-weight:700\">JML Immobilier</div><div style=\"margin-top:5px;color:#d9bd72;font-size:13px\">VOTRE PROJET, NOTRE ENGAGEMENT</div></div>" +
    "<div style=\"background:#fff;padding:28px 24px;border-radius:0 0 12px 12px\"><p>Bonjour " + safeName + ",</p>" +
    "<p>Nous avons bien reçu votre demande concernant votre projet immobilier dans les Ardennes.</p>" +
    "<p>Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.</p>" +
    "<p style=\"margin-top:28px\">À bientôt,<br><strong>JML Immobilier</strong><br><span style=\"color:#8c6d2d\">Votre projet, notre engagement</span></p></div></div></body></html>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [lead.email], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Resend " + response.status + ": " + detail.slice(0, 500));
  }
  const result = await response.json();
  return { sent: true, id: result.id || null };
}
const STATUS_VALUES = ["À qualifier","Contacté","À relancer","RDV pris","Estimation","Mandat","Pas de projet"];

function apiError(res, status, code, message, detail = null) {
  const payload = { ok:false, error:message, code };
  if (detail && process.env.NODE_ENV !== "production") payload.detail = String(detail);
  return res.status(status).json(payload);
}
function unexpected(res, code, message, err) {
  console.error(code, err);
  return apiError(res, 503, code, message, err?.message);
}

async function sendAppointmentConfirmationEmail(prospect, note = "", appointmentAt = null, appointmentLocation = "") {
  if (!prospect.email) return { sent: false, reason: "no-email" };
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM || "").trim();
  if (!apiKey || !from) {
    console.warn("JML email RDV non envoyé: RESEND_API_KEY ou RESEND_FROM manquant.");
    return { sent: false, reason: "email-provider-not-configured" };
  }
  const firstName = clean(prospect.name, 120).split(/\s+/)[0] || "Bonjour";
  const cleanNote = clean(note, 500);
  const subject = "Confirmation de votre rendez-vous — JML Immobilier";
  const appointmentDateText = appointmentAt ? new Date(appointmentAt).toLocaleString("fr-FR", { dateStyle:"full", timeStyle:"short", timeZone:"Europe/Paris" }) : "";
  const appointmentLine = appointmentDateText ? "\n\n📅 " + appointmentDateText : "";
  const locationLine = appointmentLocation ? "\n📍 " + appointmentLocation : "";
  const text = "Bonjour " + firstName + ",\n\n" +
    "Votre rendez-vous concernant votre projet immobilier a bien été enregistré avec JML Immobilier." +
    appointmentLine + locationLine +
    (cleanNote ? "\n\nInformations indiquées : " + cleanNote : "") +
    "\n\nNous pourrons échanger simplement sur votre bien, votre projet et les prochaines étapes.\n\n" +
    "À bientôt,\nJML Immobilier\nVotre projet, notre engagement";
  const safeName = firstName.replace(/[&<>"]/g, "");
  const safeNote = cleanNote.replace(/[&<>"]/g, "");
  const safeLocation = clean(appointmentLocation,250).replace(/[&<>"]/g, "");
  const dateHtml = appointmentDateText ? "<p><strong>📅 Rendez-vous :</strong><br>" + appointmentDateText + "</p>" : "";
  const locationHtml = safeLocation ? "<p><strong>📍 Lieu :</strong><br>" + safeLocation + "</p>" : "";
  const noteHtml = safeNote ? "<p><strong>Informations indiquées :</strong> " + safeNote + "</p>" : "";
  const html = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#f5f1e8;font-family:Arial,sans-serif;color:#26352f\"><div style=\"max-width:620px;margin:30px auto;padding:0 16px\">" +
    "<div style=\"background:#173b32;padding:22px 24px;border-radius:12px 12px 0 0;color:#fff\"><div style=\"font-size:22px;font-weight:700\">JML Immobilier</div><div style=\"margin-top:5px;color:#d9bd72;font-size:13px\">VOTRE PROJET, NOTRE ENGAGEMENT</div></div>" +
    "<div style=\"background:#fff;padding:28px 24px;border-radius:0 0 12px 12px\"><p>Bonjour " + safeName + ",</p>" +
    "<p><strong>Votre rendez-vous concernant votre projet immobilier a bien été enregistré.</strong></p>" + dateHtml + locationHtml + noteHtml +
    "<p>Nous pourrons échanger simplement sur votre bien, votre projet et les prochaines étapes.</p>" +
    "<p style=\"margin-top:28px\">À bientôt,<br><strong>JML Immobilier</strong><br><span style=\"color:#8c6d2d\">Votre projet, notre engagement</span></p></div></div></body></html>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [prospect.email], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Resend " + response.status + ": " + detail.slice(0, 500));
  }
  const result = await response.json();
  return { sent: true, id: result.id || null };
}

async function db(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL manquante");
  return pool.query(sql, params);
}

function dbRequired(res) {
  if (!pool) {
    res.status(503).json({ ok:false, error:"PostgreSQL n'est pas configuré sur ce serveur." });
    return false;
  }
  return true;
}

async function initDb() {
  if (!pool) return;
  await db(`
    CREATE TABLE IF NOT EXISTS jml_prospects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      phone TEXT,
      email TEXT,
      property_type TEXT NOT NULL DEFAULT 'Maison',
      horizon TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'Autre',
      status TEXT NOT NULL DEFAULT 'À qualifier',
      contact_basis TEXT NOT NULL DEFAULT 'À vérifier',
      contact_consent BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at TIMESTAMPTZ,
      notes TEXT,
      score INTEGER,
      priority TEXT,
      reasons JSONB,
      next_action TEXT,
      next_action_at TIMESTAMPTZ,
      last_contact_at TIMESTAMPTZ,
      contact_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_activities (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES jml_prospects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      note TEXT,
      outcome TEXT,
      appointment_at TIMESTAMPTZ,
      appointment_location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      property_type TEXT,
      horizon TEXT,
      source TEXT NOT NULL DEFAULT 'Lead Magnet',
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const columns = {
    city:"TEXT",
    phone:"TEXT",
    email:"TEXT",
    property_type:"TEXT NOT NULL DEFAULT 'Maison'",
    horizon:"TEXT NOT NULL DEFAULT 'unknown'",
    source:"TEXT NOT NULL DEFAULT 'Autre'",
    status:"TEXT NOT NULL DEFAULT 'À qualifier'",
    contact_basis:"TEXT NOT NULL DEFAULT 'À vérifier'",
    contact_consent:"BOOLEAN NOT NULL DEFAULT FALSE",
    consent_at:"TIMESTAMPTZ",
    notes:"TEXT",
    score:"INTEGER",
    priority:"TEXT",
    reasons:"JSONB",
    next_action:"TEXT",
    next_action_at:"TIMESTAMPTZ",
    last_contact_at:"TIMESTAMPTZ",
    contact_count:"INTEGER NOT NULL DEFAULT 0",
    created_at:"TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    updated_at:"TIMESTAMPTZ NOT NULL DEFAULT NOW()"
  };
  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS outcome TEXT`);
  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ`);
  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS appointment_location TEXT`);

  for (const [name,type] of Object.entries(columns)) {
    await db(`ALTER TABLE jml_prospects ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  await db(`
    UPDATE jml_prospects
    SET
      property_type = COALESCE(NULLIF(property_type,''),'Maison'),
      horizon = COALESCE(NULLIF(horizon,''),'unknown'),
      source = COALESCE(NULLIF(source,''),'Autre'),
      status = COALESCE(NULLIF(status,''),'À qualifier'),
      contact_basis = COALESCE(NULLIF(contact_basis,''),'À vérifier'),
      contact_count = COALESCE(contact_count,0),
      created_at = COALESCE(created_at,NOW()),
      updated_at = COALESCE(updated_at,NOW())
  `);

  await db(`
    DELETE FROM jml_prospects p
    USING jml_prospects d
    WHERE p.id <> d.id
      AND p.phone IS NOT NULL AND p.phone <> ''
      AND d.phone = p.phone
      AND p.id > d.id
  `);
  await db(`
    DELETE FROM jml_prospects p
    USING jml_prospects d
    WHERE p.id <> d.id
      AND p.email IS NOT NULL AND p.email <> ''
      AND LOWER(p.email) = LOWER(d.email)
      AND p.id > d.id
  `);

  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_updated ON jml_prospects(updated_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_status ON jml_prospects(status)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_next_action ON jml_prospects(next_action_at)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_activities_prospect ON jml_activities(prospect_id,created_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_leads_created ON jml_leads(created_at DESC)");
  await db("CREATE UNIQUE INDEX IF NOT EXISTS uq_jml_prospects_phone ON jml_prospects(phone) WHERE phone IS NOT NULL AND phone <> ''");
  await db("CREATE UNIQUE INDEX IF NOT EXISTS uq_jml_prospects_email ON jml_prospects(LOWER(email)) WHERE email IS NOT NULL AND email <> ''");
}

function normalizeProspect(body, existing = {}) {
  return {
    id: existing.id || newId(),
    name: clean(body.name ?? existing.name, 120),
    city: clean(body.city ?? existing.city, 100),
    phone: clean(body.phone ?? existing.phone, 40),
    email: cleanEmail(body.email ?? existing.email),
    property_type: clean(body.property_type ?? body.type ?? existing.property_type ?? "Maison", 60),
    horizon: clean(body.horizon ?? existing.horizon ?? "unknown", 20),
    source: clean(body.source ?? existing.source ?? "Autre", 80),
    status: clean(body.status ?? existing.status ?? "À qualifier", 40),
    contact_basis: clean(body.contact_basis ?? existing.contact_basis ?? "À vérifier", 60),
    contact_consent: toBoolean(body.contact_consent) || toBoolean(existing.contact_consent),
    consent_at: existing.consent_at || null,
    notes: clean(body.notes ?? existing.notes, 2000)
  };
}

function rowToProspect(r) {
  return {
    id:r.id,
    name:r.name,
    city:r.city || "",
    phone:r.phone || "",
    email:r.email || "",
    propertyType:r.property_type || "Maison",
    horizon:r.horizon || "unknown",
    source:r.source || "Autre",
    status:r.status || "À qualifier",
    contactBasis:r.contact_basis || "À vérifier",
    contactConsent:!!r.contact_consent,
    consentAt:r.consent_at || null,
    notes:r.notes || "",
    score:r.score ?? null,
    priority:r.priority || null,
    reasons:r.reasons || [],
    nextAction:r.next_action || null,
    nextActionAt:r.next_action_at || null,
    lastContactAt:r.last_contact_at || null,
    contactCount:r.contact_count || 0,
    createdAt:r.created_at,
    updatedAt:r.updated_at
  };
}

function scoreProspect(p) {
  let score = 20;
  const reasons = [];
  if(p.horizon === "0-3"){ score += 35; reasons.push("Projet annoncé dans les 3 mois"); }
  else if(p.horizon === "3-6"){ score += 25; reasons.push("Projet annoncé dans les 3 à 6 mois"); }
  else if(p.horizon === "6-12"){ score += 10; reasons.push("Projet identifié dans l'année"); }
  else reasons.push("Horizon à préciser");
  if(p.phone){ score += 10; reasons.push("Téléphone renseigné"); }
  if(p.email){ score += 5; reasons.push("Email renseigné"); }
  if(p.city){ score += 5; reasons.push("Commune renseignée"); }
  if(p.propertyType !== "Autre"){ score += 5; reasons.push("Type de bien identifié"); }
  if(p.source !== "Autre"){ score += 5; reasons.push("Source identifiée"); }
  if(p.contactBasis !== "À vérifier"){ score += 5; reasons.push("Base de contact renseignée"); }
  if(p.status === "RDV pris") score += 10;
  if(p.status === "Mandat") score = 100;
  score = Math.min(100, Math.max(0, score));
  const priority = score >= 75 ? "A" : score >= 50 ? "B" : "C";
  const nextAction = p.status === "Mandat" ? "Suivre le mandat et les prochaines étapes."
    : p.status === "RDV pris" ? "Préparer et confirmer le rendez-vous."
    : p.horizon === "0-3" ? "Prendre contact rapidement et proposer un rendez-vous."
    : p.horizon === "3-6" ? "Programmer une relance concrète sur le projet."
    : "Qualifier l'horizon puis programmer une prochaine action.";
  return {score,priority,reasons,nextAction};
}

app.get("/api/health", async (_req,res) => {
  let database = "memory";
  let databaseError = null;
  if(pool){
    try { await db("SELECT 1"); database = "postgres"; }
    catch(e){ database = "postgres-error"; databaseError = e.message; }
  }
  res.json({ok:true,app:"JML Projet Vendeur",version:VERSION,database, databaseError, region:"Ardennes",sector:"Charleville-Mézières"});
});

app.get("/api/diagnostic", async (_req,res) => {
  if(!pool) return res.json({ok:true,version:VERSION,database:"memory",prospects:memory.prospects.size,leads:memory.leads.size});
  try{
    const q=await db("SELECT COUNT(*)::int AS count FROM jml_prospects");
    const a=await db("SELECT COUNT(*)::int AS count FROM jml_activities");
    const l=await db("SELECT COUNT(*)::int AS count FROM jml_leads");
    const last=await db("SELECT id,name,created_at,updated_at FROM jml_prospects ORDER BY created_at DESC LIMIT 5");
    res.json({
      ok:true,
      version:VERSION,
      database:"postgres",
      prospects:q.rows[0].count,
      activities:a.rows[0].count,
      leads:l.rows[0].count,
      lastProspects:last.rows
    });
  }catch(e){
    res.status(503).json({ok:false,version:VERSION,database:"postgres-error",error:e.message});
  }
});

app.get("/api/pipeline", async (_req,res) => {
  try{
    if(pool){
      const q=await db("SELECT status,COUNT(*)::int AS count FROM jml_prospects GROUP BY status");
      const out=Object.fromEntries(STATUS_VALUES.map(s=>[s,0]));
      q.rows.forEach(r=>{ if(Object.prototype.hasOwnProperty.call(out,r.status)) out[r.status]=r.count; });
      return res.json({ok:true,pipeline:out});
    }
    const out=Object.fromEntries(STATUS_VALUES.map(s=>[s,0]));
    for(const p of memory.prospects.values()) out[p.status]=(out[p.status]||0)+1;
    res.json({ok:true,pipeline:out});
  }catch(e){ unexpected(res,"JML-P006","Pipeline indisponible.",e); }
});

app.get("/api/prospects", async (_req,res) => {
  try{
    if(pool){
      const q=await db("SELECT * FROM jml_prospects ORDER BY updated_at DESC, created_at DESC");
      return res.json({ok:true,persisted:true,prospects:q.rows.map(rowToProspect)});
    }
    res.json({ok:true,persisted:false,prospects:[...memory.prospects.values()].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))});
  }catch(e){
    unexpected(res,"JML-P005","Lecture des prospects indisponible.",e);
  }
});

app.post("/api/prospects", async (req,res) => {
  const p=normalizeProspect(req.body||{});
  if(!p.name) return apiError(res,400,"JML-P001","Nom / prénom requis.");
  if(!validEmail(p.email)) return apiError(res,400,"JML-P002","Email invalide.");
  
  try{
    if(pool){
      const dup=await db(`SELECT id,name FROM jml_prospects
        WHERE (phone IS NOT NULL AND phone <> '' AND phone=$1)
           OR (email IS NOT NULL AND email <> '' AND LOWER(email)=LOWER($2))
        LIMIT 1`,[p.phone||null,p.email||null]);
      if(dup.rowCount) return apiError(res,409,"JML-P003","Ce prospect existe déjà dans le CRM.");
      const t=now();
      const consentAt=p.contact_consent?t:null;
      await db(`INSERT INTO jml_prospects
        (id,name,city,phone,email,property_type,horizon,source,status,contact_basis,contact_consent,consent_at,notes,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.contact_consent,consentAt,p.notes||null,t,t]);
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[p.id]);
      return res.status(201).json({ok:true,persisted:true,prospect:rowToProspect(q.rows[0])});
    }
    const out={...p,createdAt:now(),updatedAt:now()};
    memory.prospects.set(p.id,out);
    res.status(201).json({ok:true,persisted:false,prospect:out});
  }catch(e){
    if(e.code==="23505") return apiError(res,409,"JML-P003","Ce prospect existe déjà dans le CRM.");
    unexpected(res,"JML-P004","Enregistrement du prospect indisponible.",e);
  }
});

app.put("/api/prospects/:id/status", async (req,res) => {
  const status=clean(req.body?.status,40);
  if(!STATUS_VALUES.includes(status)) return apiError(res,400,"JML-P007","Statut invalide.");
  try{
    if(pool){
      const q=await db("UPDATE jml_prospects SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,status]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,prospect:rowToProspect(q.rows[0])});
    }
    const p=memory.prospects.get(req.params.id);
    if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    p.status=status;p.updatedAt=now();memory.prospects.set(p.id,p);
    res.json({ok:true,prospect:p});
  }catch(e){unexpected(res,"JML-P008","Modification du statut indisponible.",e);}
});

app.put("/api/prospects/:id", async (req,res) => {
  try{
    if(pool){
      const old=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!old.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      const p=normalizeProspect(req.body||{},rowToProspect(old.rows[0]));
      if(!p.name) return apiError(res,400,"JML-P001","Nom / prénom requis.");
      if(!validEmail(p.email)) return apiError(res,400,"JML-P002","Email invalide.");
      const consentAt=p.contact_consent?(old.rows[0].consent_at||now()):null;
      await db(`UPDATE jml_prospects SET name=$2,city=$3,phone=$4,email=$5,property_type=$6,horizon=$7,source=$8,status=$9,contact_basis=$10,contact_consent=$11,consent_at=$12,notes=$13,updated_at=NOW() WHERE id=$1`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.contact_consent,consentAt,p.notes||null]);
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[p.id]);
      return res.json({ok:true,persisted:true,prospect:rowToProspect(q.rows[0])});
    }
    const old=memory.prospects.get(req.params.id);
    if(!old) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    const p=normalizeProspect(req.body||{},old);
    const out={...old,...p,updatedAt:now()};
    memory.prospects.set(p.id,out);
    res.json({ok:true,persisted:false,prospect:out});
  }catch(e){unexpected(res,"JML-P009","Modification indisponible.",e);}
});

app.post("/api/prospects/:id/qualify", async (req,res) => {
  try{
    let p;
    if(pool){
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      p=rowToProspect(q.rows[0]);
    }else{
      p=memory.prospects.get(req.params.id);
      if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    }
    const q=scoreProspect(p);
    if(pool) await db("UPDATE jml_prospects SET score=$2,priority=$3,reasons=$4,next_action=$5,updated_at=NOW() WHERE id=$1",[p.id,q.score,q.priority,JSON.stringify(q.reasons),q.nextAction]);
    else memory.prospects.set(p.id,{...p,...q,updatedAt:now()});
    res.json({ok:true,...q});
  }catch(e){unexpected(res,"JML-P010","Qualification indisponible.",e);}
});

app.get("/api/prospects/:id/activities", async (req,res) => {
  try{
    if(pool){
      const q=await db("SELECT id,type,note,outcome,appointment_at,appointment_location,created_at FROM jml_activities WHERE prospect_id=$1 ORDER BY created_at DESC LIMIT 100",[req.params.id]);
      return res.json({ok:true,activities:q.rows});
    }
    res.json({ok:true,activities:[]});
  }catch(e){unexpected(res,"JML-P011","Historique indisponible.",e);}
});

app.post("/api/prospects/:id/activity", async (req,res) => {
  const type=clean(req.body?.type,40);
  const note=clean(req.body?.note,1000);
  const outcome=clean(req.body?.outcome,80);
  const appointmentAtRaw=clean(req.body?.appointmentAt,60);
  const appointmentAt=appointmentAtRaw?new Date(appointmentAtRaw):null;
  const appointmentLocation=clean(req.body?.appointmentLocation,250);
  if(appointmentAt && Number.isNaN(appointmentAt.getTime())) return res.status(400).json({ok:false,error:"Date du rendez-vous invalide."});
  const allowedOutcomes=["Pas de réponse","Intéressé","À rappeler","RDV pris","Pas de projet","Refus"];
  if(outcome && !allowedOutcomes.includes(outcome)) return res.status(400).json({ok:false,error:"Résultat d'action invalide."});
  const allowed=["Appel","SMS","Email","RDV","Visite","Note"];
  if(!allowed.includes(type)) return res.status(400).json({ok:false,error:"Type d'action invalide."});
  try{
    if(pool){
      const exists=await db("SELECT id FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!exists.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      const id=newId(),t=now();
      await db("INSERT INTO jml_activities (id,prospect_id,type,note,outcome,appointment_at,appointment_location,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[id,req.params.id,type,note||null,outcome||null,appointmentAt,appointmentLocation||null,t]);
      if(["Appel","SMS","Email","RDV","Visite"].includes(type)){
        await db("UPDATE jml_prospects SET last_contact_at=$2,contact_count=contact_count+1,updated_at=NOW() WHERE id=$1",[req.params.id,t]);
      }
      let emailConfirmation = { sent: false, reason: "not-applicable" };
      if(outcome==="RDV pris") {
        await db("UPDATE jml_prospects SET status='RDV pris',next_action='Préparer et confirmer le rendez-vous.',next_action_at=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);
        const prospectResult = await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
        if(prospectResult.rowCount) {
          try {
            emailConfirmation = await sendAppointmentConfirmationEmail(rowToProspect(prospectResult.rows[0]), note, appointmentAt, appointmentLocation);
          } catch (emailErr) {
            console.error("JML appointment confirmation failed:", emailErr);
            emailConfirmation = { sent: false, reason: "send-failed" };
          }
        }
      }
      if(outcome==="Pas de projet"||outcome==="Refus") await db("UPDATE jml_prospects SET status='Pas de projet',next_action=NULL,next_action_at=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="À rappeler") await db("UPDATE jml_prospects SET status='À relancer',next_action='Rappeler suite au dernier échange.',next_action_at=NOW()+INTERVAL '2 days',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="Intéressé") await db("UPDATE jml_prospects SET status='Contacté',next_action='Proposer un rendez-vous vendeur.',next_action_at=NOW()+INTERVAL '1 day',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="Pas de réponse") await db("UPDATE jml_prospects SET status='À relancer',next_action='Nouvelle tentative de contact.',next_action_at=NOW()+INTERVAL '3 days',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(!["Appel","SMS","Email","RDV","Visite"].includes(type) && !outcome) await db("UPDATE jml_prospects SET updated_at=NOW() WHERE id=$1",[req.params.id]);
      return res.status(201).json({ok:true,activity:{id,type,note,outcome:outcome||null,created_at:t},emailConfirmation});
    }
    let emailConfirmation = { sent: false, reason: "not-applicable" };
    if(outcome==="RDV pris") {
      const prospect = memory.prospects.get(req.params.id);
      if(prospect) {
        try {
          emailConfirmation = await sendAppointmentConfirmationEmail(prospect, note);
        } catch (emailErr) {
          console.error("JML appointment confirmation failed:", emailErr);
          emailConfirmation = { sent: false, reason: "send-failed" };
        }
      }
    }
    res.status(201).json({ok:true,activity:{id:newId(),type,note,outcome:outcome||null,created_at:now()},emailConfirmation});
  }catch(e){unexpected(res,"JML-P012","Enregistrement de l'action indisponible.",e);}
});

app.put("/api/prospects/:id/follow-up", async (req,res) => {
  const nextAction=clean(req.body?.nextAction,500);
  const raw=req.body?.nextActionAt;
  const nextActionAt=raw?new Date(raw):null;
  if(nextActionAt && Number.isNaN(nextActionAt.getTime())) return res.status(400).json({ok:false,error:"Date de relance invalide."});
  try{
    if(pool){
      const q=await db("UPDATE jml_prospects SET next_action=$2,next_action_at=$3,updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,nextAction||null,nextActionAt]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,prospect:rowToProspect(q.rows[0])});
    }
    const p=memory.prospects.get(req.params.id);
    if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    p.nextAction=nextAction||null;p.nextActionAt=nextActionAt?p.nextActionAt=nextActionAt.toISOString():null;p.updatedAt=now();
    memory.prospects.set(p.id,p);
    res.json({ok:true,prospect:p});
  }catch(e){unexpected(res,"JML-P013","Programmation de la relance indisponible.",e);}
});

app.delete("/api/prospects/:id", async (req,res) => {
  try{
    if(pool){
      const q=await db("DELETE FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,persisted:true});
    }
    memory.prospects.delete(req.params.id);
    res.json({ok:true,persisted:false});
  }catch(e){unexpected(res,"JML-P014","Suppression indisponible.",e);}
});

app.post("/api/leads", async (req,res) => {
  const b=req.body||{};
  const lead={id:newId(),name:clean(b.name,120),email:clean(b.email,180),phone:clean(b.phone,40),city:clean(b.city,100),propertyType:clean(b.propertyType,60),horizon:clean(b.horizon,20),source:clean(b.source||"Lead Magnet",80),consent:toBoolean(b.consent),createdAt:now()};
  if(!lead.name) return apiError(res,400,"JML-L003","Nom requis.");
  if(!lead.email&&!lead.phone) return apiError(res,400,"JML-L004","Email ou téléphone requis.");
  if(!validEmail(lead.email)) return apiError(res,400,"JML-L005","Email invalide.");
  if(!lead.consent) return apiError(res,400,"JML-L006","Consentement requis.");
  try{
    if(pool){
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO jml_leads (id,name,email,phone,city,property_type,horizon,source,consent,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [lead.id,lead.name,lead.email||null,lead.phone||null,lead.city||null,lead.propertyType||null,lead.horizon||null,lead.source,true,lead.createdAt]
        );

        // Une demande explicite devient immédiatement un prospect exploitable.
        // Si le contact existe déjà, on réutilise la fiche au lieu de créer un doublon.
        let existing=null;
        if(lead.phone||lead.email){
          const dup=await client.query(
            `SELECT * FROM jml_prospects
             WHERE (phone IS NOT NULL AND phone <> '' AND phone=$1)
                OR (email IS NOT NULL AND email <> '' AND LOWER(email)=LOWER($2))
             ORDER BY created_at ASC LIMIT 1`,
            [lead.phone||null,lead.email||null]
          );
          if(dup.rowCount) existing=dup.rows[0];
        }

        let prospectId=existing?.id||newId();
        if(!existing){
          const p=normalizeProspect({
            name:lead.name,
            city:lead.city,
            phone:lead.phone,
            email:lead.email,
            property_type:lead.propertyType||"Maison",
            horizon:lead.horizon||"unknown",
            source:lead.source||"Lead Magnet",
            status:"À qualifier",
            contact_basis:"Contact demandé par la personne",
            contact_consent:true,
            notes:"Demande captée via formulaire JML. Recontact autorisé."
          });
          p.id=prospectId;
          const q=scoreProspect(p);
          const nextAt=p.horizon==="0-3" ? new Date(Date.now()+24*3600*1000)
            : p.horizon==="3-6" ? new Date(Date.now()+3*24*3600*1000) : null;
          await client.query(
            `INSERT INTO jml_prospects
             (id,name,city,phone,email,property_type,horizon,source,status,contact_basis,contact_consent,consent_at,notes,score,priority,reasons,next_action,next_action_at,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,true,lead.createdAt,p.notes||null,q.score,q.priority,JSON.stringify(q.reasons),q.nextAction,nextAt,lead.createdAt,lead.createdAt]
          );
        }
        await client.query("COMMIT");

        let emailConfirmation = { sent: false, reason: "no-email" };
        try {
          emailConfirmation = await sendLeadConfirmationEmail(lead);
        } catch (emailErr) {
          console.error("JML email confirmation failed:", emailErr);
          emailConfirmation = { sent: false, reason: "send-failed" };
        }

        return res.status(201).json({ok:true,persisted:true,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation});
      }catch(txErr){
        await client.query("ROLLBACK");
        throw txErr;
      }finally{
        client.release();
      }
    }

    memory.leads.set(lead.id,lead);
    const existing=[...memory.prospects.values()].find(p=>
      (lead.phone&&p.phone&&lead.phone===p.phone) ||
      (lead.email&&p.email&&lead.email.toLowerCase()===String(p.email).toLowerCase())
    );
    let prospectId=existing?.id;
    if(!existing){
      const p=normalizeProspect({
        name:lead.name,city:lead.city,phone:lead.phone,email:lead.email,
        property_type:lead.propertyType||"Maison",horizon:lead.horizon||"unknown",
        source:lead.source||"Lead Magnet",status:"À qualifier",
        contact_basis:"Contact demandé par la personne",contact_consent:true,
        notes:"Demande captée via formulaire JML. Recontact autorisé."
      });
      const q=scoreProspect(p);
      const nextAt=p.horizon==="0-3" ? new Date(Date.now()+24*3600*1000).toISOString()
        : p.horizon==="3-6" ? new Date(Date.now()+3*24*3600*1000).toISOString() : null;
      const out={...p,...q,nextActionAt:nextAt,createdAt:lead.createdAt,updatedAt:lead.createdAt};
      memory.prospects.set(p.id,out);
      prospectId=p.id;
    }
    let emailConfirmation = { sent: false, reason: "no-email" };
    try {
      emailConfirmation = await sendLeadConfirmationEmail(lead);
    } catch (emailErr) {
      console.error("JML email confirmation failed:", emailErr);
      emailConfirmation = { sent: false, reason: "send-failed" };
    }

    res.status(201).json({ok:true,persisted:false,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation});
  }catch(e){unexpected(res,"JML-L001","Enregistrement du lead indisponible.",e);}
});

app.get("/api/leads", async (_req,res) => {
  try{
    if(pool){const q=await db("SELECT * FROM jml_leads ORDER BY created_at DESC LIMIT 500");return res.json({ok:true,persisted:true,leads:q.rows});}
    res.json({ok:true,persisted:false,leads:[...memory.leads.values()].reverse()});
  }catch(e){res.status(503).json({ok:false,error:"Lecture des leads indisponible.",detail:e.message});}
});



function buildMandatIntelligence(prospects, activitiesByProspect = new Map()){
  const nowMs=Date.now();
  return prospects.map(p=>{
    const reasons=[];
    const daysSinceContact=p.last_contact_at ? Math.floor((nowMs-new Date(p.last_contact_at).getTime())/86400000) : null;
    if(p.horizon==="0-3") reasons.push("Projet annoncé dans les 3 mois");
    else if(p.horizon==="3-6") reasons.push("Projet annoncé dans les 3 à 6 mois");
    if(p.status==="À relancer") reasons.push("Relance déjà prévue");
    if(p.status==="RDV pris") reasons.push("Rendez-vous déjà obtenu");
    if(p.status==="Estimation") reasons.push("Étape estimation en cours");
    if(daysSinceContact !== null && daysSinceContact >= 30) reasons.push("Aucun contact depuis "+daysSinceContact+" jours");
    if(p.contact_count===0) reasons.push("Premier contact à réaliser");
    const last=(activitiesByProspect.get(p.id)||[])[0]||null;
    if(last?.outcome==="À rappeler") reasons.push("Le dernier échange demande un rappel");
    if(last?.outcome==="Intéressé") reasons.push("Intérêt vendeur confirmé lors du dernier échange");
    const baseScore=Number.isFinite(Number(p.score)) ? Number(p.score) : 0;
    let priorityBoost=0;
    if(p.horizon==="0-3") priorityBoost+=30;
    if(p.horizon==="3-6") priorityBoost+=20;
    if(last?.outcome==="À rappeler") priorityBoost+=15;
    if(p.status==="RDV pris") priorityBoost+=15;
    if(p.status==="Estimation") priorityBoost+=20;
    if(daysSinceContact>=30) priorityBoost+=10;
    const action=p.status==="RDV pris" ? "Préparer le rendez-vous"
      : p.status==="Estimation" ? "Faire le suivi de l'estimation"
      : p.horizon==="0-3" ? "Appeler et proposer un rendez-vous"
      : p.horizon==="3-6" ? "Programmer une relance datée"
      : "Qualifier le projet puis planifier la prochaine action";
    return {id:p.id,name:p.name,city:p.city||"",status:p.status,horizon:p.horizon,score:baseScore,priority:p.priority||null,
      reasons:reasons.slice(0,5),priorityBoost,nextAction:action,lastOutcome:last?.outcome||null,lastActivityAt:last?.created_at||null};
  }).filter(x=>x.status!=="Mandat"&&x.status!=="Pas de projet")
    .sort((a,b)=>((b.score||0)+(b.priorityBoost||0))-((a.score||0)+(a.priorityBoost||0))).slice(0,5);
}

app.get("/api/mandat-intelligence", async (_req,res)=>{
  try{
    let prospects=[],activities=[];
    if(pool){
      const p=await db("SELECT * FROM jml_prospects WHERE status NOT IN ('Mandat','Pas de projet') ORDER BY updated_at DESC");
      const a=await db("SELECT prospect_id,id,type,note,outcome,created_at FROM jml_activities ORDER BY created_at DESC LIMIT 1000");
      prospects=p.rows;activities=a.rows;
    }else prospects=[...memory.prospects.values()].filter(p=>p.status!=="Mandat"&&p.status!=="Pas de projet");
    const map=new Map();
    activities.forEach(a=>{if(!map.has(a.prospect_id))map.set(a.prospect_id,[]);map.get(a.prospect_id).push(a);});
    res.json({ok:true,count:prospects.length,priorities:buildMandatIntelligence(prospects,map),modules:[
      {key:"reactivation",label:"Réactivation des anciennes opportunités",prompts:[1,2,5,7]},
      {key:"rdv",label:"Préparation du rendez-vous vendeur",prompts:[9,10,12,13,15]},
      {key:"objections",label:"Traitement des objections",prompts:[23,24,25,27]},
      {key:"daily",label:"Priorités du jour",prompts:[37,39]}
    ]});
  }catch(e){unexpected(res,"JML-P015","Intelligence mandat indisponible.",e);}
});

app.get("/api/publication-ideas",(_req,res)=>res.json([
  {title:"Prix réel vs prix espéré",target:"vendeurs",hook:"Votre maison vaut-elle vraiment le prix que vous avez en tête ?"},
  {title:"Travaux avant vente",target:"vendeurs",hook:"Faut-il vraiment refaire sa maison avant de la vendre ?"},
  {title:"Erreur d'estimation",target:"vendeurs",hook:"L'erreur d'estimation qui peut coûter cher à un propriétaire."},
  {title:"Marché local",target:"vendeurs",hook:"Que nous dit le marché immobilier de votre commune ?"},
  {title:"DPE",target:"vendeurs",hook:"DPE : ce qu'un propriétaire doit vérifier avant de vendre."},
  {title:"Vente dans 6 mois",target:"vendeurs",hook:"Vous pensez vendre dans quelques mois ? Commencez par ceci."}
]));

app.get("/guide",(_req,res)=>res.sendFile(path.join(__dirname,"public","guide.html")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

async function start(){
  try{
    await initDb();
    app.listen(PORT,()=>console.log(`JML Projet Vendeur v${VERSION} on ${PORT}`));
  }catch(err){
    console.error("DB init failed:",err);
    if(hasDatabase){
      app.listen(PORT,()=>console.log(`JML Projet Vendeur v${VERSION} started with DATABASE ERROR`));
    }else{
      app.listen(PORT,()=>console.log(`JML Projet Vendeur v${VERSION} without DATABASE_URL`));
    }
  }
}
start();
