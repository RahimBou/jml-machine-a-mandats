const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = "1.0.0";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
}) : null;

const memory = { prospects: new Map(), leads: new Map() };
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function db(sql, params = []) { return pool ? pool.query(sql, params) : null; }

async function initDb() {
  if (!pool) return;
  await db(\`
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
      notes TEXT,
      score INTEGER,
      priority TEXT,
      reasons JSONB,
      next_action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_jml_prospects_updated ON jml_prospects(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jml_prospects_status ON jml_prospects(status);
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
    CREATE INDEX IF NOT EXISTS idx_jml_leads_created ON jml_leads(created_at DESC);
  \`);
}

function normalizeProspect(body, existing = {}) {
  return {
    id: existing.id || newId(),
    name: clean(body.name, 120),
    city: clean(body.city, 100),
    phone: clean(body.phone, 40),
    email: clean(body.email, 180),
    property_type: clean(body.property_type || body.type || existing.property_type || "Maison", 60),
    horizon: clean(body.horizon || existing.horizon || "unknown", 20),
    source: clean(body.source || existing.source || "Autre", 80),
    status: clean(body.status || existing.status || "À qualifier", 40),
    contact_basis: clean(body.contact_basis || existing.contact_basis || "À vérifier", 60),
    notes: clean(body.notes, 2000)
  };
}

function rowToProspect(r) {
  return {
    id:r.id,name:r.name,city:r.city||"",phone:r.phone||"",email:r.email||"",
    propertyType:r.property_type,horizon:r.horizon,source:r.source,status:r.status,
    contactBasis:r.contact_basis,notes:r.notes||"",score:r.score ?? null,
    priority:r.priority||null,reasons:r.reasons||[],nextAction:r.next_action||null,
    createdAt:r.created_at,updatedAt:r.updated_at
  };
}

function scoreProspect(p) {
  let score=20; const reasons=[];
  if(p.horizon==="0-3"){score+=35;reasons.push("Projet annoncé dans les 3 mois")}
  else if(p.horizon==="3-6"){score+=25;reasons.push("Projet annoncé dans les 3 à 6 mois")}
  else if(p.horizon==="6-12"){score+=10;reasons.push("Projet identifié dans l'année")}
  else reasons.push("Horizon à préciser");
  if(p.phone){score+=10;reasons.push("Téléphone renseigné")}
  if(p.email){score+=5;reasons.push("Email renseigné")}
  if(p.city){score+=5;reasons.push("Commune renseignée")}
  if(p.property_type!=="Autre"){score+=5;reasons.push("Type de bien identifié")}
  if(p.source!=="Autre"){score+=5;reasons.push("Source identifiée")}
  if(p.contact_basis!=="À vérifier"){score+=5;reasons.push("Base de contact renseignée")}
  if(p.status==="RDV pris")score+=10;
  if(p.status==="Mandat")score=100;
  score=Math.min(100,Math.max(0,score));
  const priority=score>=75?"A":score>=50?"B":"C";
  const nextAction=p.status==="Mandat"?"Suivre le mandat et les prochaines étapes."
    :p.status==="RDV pris"?"Préparer et confirmer le rendez-vous."
    :p.horizon==="0-3"?"Prendre contact rapidement et proposer un rendez-vous."
    :p.horizon==="3-6"?"Programmer une relance concrète sur le projet."
    :"Qualifier l'horizon puis programmer une prochaine action.";
  return {score,priority,reasons,nextAction};
}

app.get("/api/health", async (_req,res)=>{
  let database="memory";
  if(pool){try{await db("SELECT 1");database="postgres"}catch{database="postgres-error"}}
  res.json({ok:true,app:"JML Machine à Mandats",version:VERSION,database,region:"Ardennes",sector:"Charleville-Mézières"});
});

app.get("/api/prospects", async (_req,res)=>{
  try{
    if(pool){const q=await db("SELECT * FROM jml_prospects ORDER BY updated_at DESC");return res.json({ok:true,persisted:true,prospects:q.rows.map(rowToProspect)})}
    res.json({ok:true,persisted:false,prospects:[...memory.prospects.values()].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))});
  }catch{res.status(500).json({ok:false,error:"Lecture des prospects indisponible."})}
});

app.post("/api/prospects", async (req,res)=>{
  const p=normalizeProspect(req.body||{});
  if(!p.name)return res.status(400).json({ok:false,error:"Nom / prénom requis."});
  if(!validEmail(p.email))return res.status(400).json({ok:false,error:"Email invalide."});
  if(p.contact_basis==="À vérifier")return res.status(400).json({ok:false,error:"Base de contact à préciser avant l'enregistrement."});
  const t=now();
  try{
    if(pool){
      await db(\`INSERT INTO jml_prospects
        (id,name,city,phone,email,property_type,horizon,source,status,contact_basis,notes,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)\`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.notes||null,t]);
      return res.status(201).json({ok:true,persisted:true,prospect:{...p,createdAt:t,updatedAt:t}});
    }
    const out={...p,createdAt:t,updatedAt:t};memory.prospects.set(p.id,out);
    res.status(201).json({ok:true,persisted:false,prospect:out});
  }catch(e){res.status(500).json({ok:false,error:"Enregistrement du prospect indisponible."})}
});

app.put("/api/prospects/:id", async (req,res)=>{
  try{
    if(pool){
      const old=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!old.rowCount)return res.status(404).json({ok:false,error:"Prospect introuvable."});
      const p=normalizeProspect(req.body||{},rowToProspect(old.rows[0]));
      if(!p.name)return res.status(400).json({ok:false,error:"Nom / prénom requis."});
      if(!validEmail(p.email))return res.status(400).json({ok:false,error:"Email invalide."});
      await db(\`UPDATE jml_prospects SET name=$2,city=$3,phone=$4,email=$5,property_type=$6,horizon=$7,source=$8,status=$9,contact_basis=$10,notes=$11,updated_at=NOW() WHERE id=$1\`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.notes||null]);
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[p.id]);
      return res.json({ok:true,persisted:true,prospect:rowToProspect(q.rows[0])});
    }
    const old=memory.prospects.get(req.params.id);
    if(!old)return res.status(404).json({ok:false,error:"Prospect introuvable."});
    const p=normalizeProspect(req.body||{},old);const out={...old,...p,updatedAt:now()};memory.prospects.set(p.id,out);
    res.json({ok:true,persisted:false,prospect:out});
  }catch{res.status(500).json({ok:false,error:"Modification indisponible."})}
});

app.delete("/api/prospects/:id", async (req,res)=>{
  try{
    if(pool){const q=await db("DELETE FROM jml_prospects WHERE id=$1",[req.params.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Prospect introuvable."});return res.json({ok:true,persisted:true})}
    memory.prospects.delete(req.params.id);res.json({ok:true,persisted:false});
  }catch{res.status(500).json({ok:false,error:"Suppression indisponible."})}
});

app.post("/api/prospects/:id/qualify", async (req,res)=>{
  try{
    let p;
    if(pool){const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);if(!q.rowCount)return res.status(404).json({ok:false,error:"Prospect introuvable."});p=rowToProspect(q.rows[0])}
    else{p=memory.prospects.get(req.params.id);if(!p)return res.status(404).json({ok:false,error:"Prospect introuvable."})}
    const q=scoreProspect(p);
    if(pool)await db("UPDATE jml_prospects SET score=$2,priority=$3,reasons=$4,next_action=$5,updated_at=NOW() WHERE id=$1",[p.id,q.score,q.priority,JSON.stringify(q.reasons),q.nextAction]);
    else memory.prospects.set(p.id,{...p,...q,updatedAt:now()});
    res.json({ok:true,...q});
  }catch{res.status(500).json({ok:false,error:"Qualification indisponible."})}
});

app.post("/api/leads", async (req,res)=>{
  const b=req.body||{};
  const lead={id:newId(),name:clean(b.name,120),email:clean(b.email,180),phone:clean(b.phone,40),city:clean(b.city,100),propertyType:clean(b.propertyType,60),horizon:clean(b.horizon,20),source:clean(b.source||"Lead Magnet",80),consent:b.consent===true||b.consent==="true",createdAt:now()};
  if(!lead.name)return res.status(400).json({ok:false,error:"Nom requis."});
  if(!lead.email&&!lead.phone)return res.status(400).json({ok:false,error:"Email ou téléphone requis."});
  if(!validEmail(lead.email))return res.status(400).json({ok:false,error:"Email invalide."});
  if(!lead.consent)return res.status(400).json({ok:false,error:"Consentement requis."});
  try{
    if(pool){await db(\`INSERT INTO jml_leads (id,name,email,phone,city,property_type,horizon,source,consent,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)\`,
      [lead.id,lead.name,lead.email||null,lead.phone||null,lead.city||null,lead.propertyType||null,lead.horizon||null,lead.source,true,lead.createdAt]);return res.status(201).json({ok:true,persisted:true,id:lead.id})}
    memory.leads.set(lead.id,lead);res.status(201).json({ok:true,persisted:false,id:lead.id});
  }catch{res.status(500).json({ok:false,error:"Enregistrement du lead indisponible."})}
});

app.get("/api/leads", async (_req,res)=>{
  try{if(pool){const q=await db("SELECT * FROM jml_leads ORDER BY created_at DESC LIMIT 500");return res.json({ok:true,persisted:true,leads:q.rows})}res.json({ok:true,persisted:false,leads:[...memory.leads.values()].reverse()})}
  catch{res.status(500).json({ok:false,error:"Lecture des leads indisponible."})}
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

initDb().then(()=>app.listen(PORT,()=>console.log(\`JML Machine à Mandats v\${VERSION} on \${PORT}\`)))
.catch(err=>{console.error("DB init:",err.message);app.listen(PORT,()=>console.log(\`JML Machine à Mandats v\${VERSION} without DB\`));});
