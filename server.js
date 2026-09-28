const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;
const VERSION = "0.4.0";

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const modules = [
  { id: "dashboard", label: "Tableau de bord", icon: "⌂" },
  { id: "prospects", label: "Prospects", icon: "◎" },
  { id: "publication", label: "JML Publication", icon: "✦" },
  { id: "leadmagnet", label: "Lead Magnet", icon: "↳" },
  { id: "relances", label: "Relances", icon: "↻" },
  { id: "kpi", label: "KPI", icon: "▦" }
];

const memoryLeads = [];
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      property_type TEXT,
      horizon TEXT,
      source TEXT,
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function clean(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function validEmail(email) {
  return !email || /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}

function leadFromBody(body) {
  return {
    id: crypto.randomUUID(),
    name: clean(body.name, 120),
    email: clean(body.email, 180),
    phone: clean(body.phone, 40),
    city: clean(body.city, 100),
    property_type: clean(body.propertyType, 60),
    horizon: clean(body.horizon, 30),
    source: clean(body.source || "Lead Magnet", 80),
    consent: body.consent === true || body.consent === "true",
    created_at: new Date().toISOString()
  };
}

app.get("/api/health", async (_req, res) => {
  let database = "memory";
  if (pool) {
    try { await pool.query("SELECT 1"); database = "postgres"; }
    catch (_e) { database = "postgres-error"; }
  }
  res.json({
    ok: true,
    app: "JML Machine à Mandats",
    version: VERSION,
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières",
    database
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières",
    modules
  });
});

app.get("/guide", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "guide.html"));
});

app.post("/api/leads", async (req, res) => {
  const lead = leadFromBody(req.body || {});
  if (!lead.name) return res.status(400).json({ ok: false, error: "Nom requis." });
  if (!lead.email && !lead.phone) return res.status(400).json({ ok: false, error: "Email ou téléphone requis." });
  if (!validEmail(lead.email)) return res.status(400).json({ ok: false, error: "Email invalide." });
  if (!lead.consent) return res.status(400).json({ ok: false, error: "Consentement requis." });

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO leads (id,name,email,phone,city,property_type,horizon,source,consent,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [lead.id, lead.name, lead.email || null, lead.phone || null, lead.city || null,
         lead.property_type || null, lead.horizon || null, lead.source || "Lead Magnet",
         lead.consent, lead.created_at]
      );
      return res.status(201).json({ ok: true, id: lead.id, persisted: true });
    } catch (_e) {
      return res.status(500).json({ ok: false, error: "Enregistrement indisponible." });
    }
  }

  memoryLeads.push(lead);
  return res.status(201).json({ ok: true, id: lead.id, persisted: false });
});

app.get("/api/leads", async (_req, res) => {
  if (pool) {
    try {
      const result = await pool.query("SELECT id,name,email,phone,city,property_type,horizon,source,consent,created_at FROM leads ORDER BY created_at DESC LIMIT 500");
      return res.json({ ok: true, persisted: true, leads: result.rows });
    } catch (_e) {
      return res.status(500).json({ ok: false, error: "Lecture indisponible." });
    }
  }
  res.json({ ok: true, persisted: false, leads: memoryLeads.slice().reverse() });
});

app.post("/api/qualify", (req, res) => {
  const p = req.body || {};
  let score = 20;
  const reasons = [];

  if (p.horizon === "0-3") { score += 35; reasons.push("Projet annoncé dans les 3 mois"); }
  else if (p.horizon === "3-6") { score += 25; reasons.push("Projet annoncé dans les 3 à 6 mois"); }
  else if (p.horizon === "6-12") { score += 10; reasons.push("Projet identifié dans l'année"); }
  else if (p.horizon === "unknown") reasons.push("Horizon à préciser");

  if (p.phone) { score += 10; reasons.push("Téléphone renseigné"); }
  if (p.email) { score += 5; reasons.push("Email renseigné"); }
  if (p.city) { score += 5; reasons.push("Commune renseignée"); }
  if (p.type && p.type !== "Autre") { score += 5; reasons.push("Type de bien identifié"); }
  if (p.source) { score += 5; reasons.push("Source du contact identifiée"); }
  if (p.status === "RDV pris") score += 10;
  if (p.status === "Mandat") score = 100;

  score = Math.max(0, Math.min(100, score));
  const priority = score >= 75 ? "A" : score >= 50 ? "B" : "C";
  const nextAction =
    p.status === "Mandat" ? "Suivre le mandat et préparer les prochaines étapes." :
    p.status === "RDV pris" ? "Préparer le rendez-vous et confirmer les informations du bien." :
    p.horizon === "0-3" ? "Prendre contact rapidement et proposer un rendez-vous." :
    p.horizon === "3-6" ? "Relancer avec une proposition concrète d'échange sur le projet." :
    p.horizon === "unknown" ? "Qualifier l'horizon du projet avant toute relance." :
    "Entretenir le contact sans pression et programmer une prochaine relance.";

  res.json({ score, priority, reasons, nextAction });
});

app.post("/api/relance-message", (req, res) => {
  const p = req.body || {};
  const name = clean(p.name, 120) || "Bonjour";
  let message = `Bonjour ${name}, je me permets de revenir vers vous concernant votre projet immobilier. Où en êtes-vous aujourd'hui ? Si vous le souhaitez, nous pouvons faire un point simplement sur votre bien et sur le calendrier de votre projet. Bonne journée, Abderrahim — JML Immobilier.`;
  if (p.horizon === "0-3") {
    message = `Bonjour ${name}, je reviens vers vous au sujet de votre projet de vente. Comme votre projet se rapproche, je peux vous proposer un point rapide sur la valeur actuelle de votre bien et les étapes à anticiper. Dites-moi simplement quand vous êtes disponible. Bonne journée, Abderrahim — JML Immobilier.`;
  } else if (p.horizon === "3-6") {
    message = `Bonjour ${name}, je prends simplement des nouvelles de votre projet de vente. Si votre échéance se précise, je peux vous aider à préparer les prochaines étapes et à faire le point sur le marché de votre secteur. Bonne journée, Abderrahim — JML Immobilier.`;
  }
  res.json({ message });
});

app.get("/api/publication-ideas", (_req, res) => {
  res.json([
    { title: "Prix réel vs prix espéré", target: "vendeurs", hook: "Votre maison vaut-elle vraiment le prix que vous avez en tête ?" },
    { title: "Travaux avant vente", target: "vendeurs", hook: "Faut-il vraiment refaire sa maison avant de la vendre ?" },
    { title: "Erreur d'estimation", target: "vendeurs", hook: "L'erreur d'estimation qui peut coûter cher à un propriétaire." },
    { title: "Marché local", target: "vendeurs", hook: "Que nous dit le marché immobilier de votre commune ?" },
    { title: "Quartier", target: "local", hook: "Ce qui peut faire varier la valeur d'une maison dans votre secteur." },
    { title: "DPE", target: "vendeurs", hook: "DPE : ce qu'un propriétaire doit vérifier avant de vendre." },
    { title: "Préparer une vente", target: "vendeurs", hook: "Les 5 choses à préparer avant de mettre son bien en vente." },
    { title: "Acheteur", target: "acheteurs", hook: "Avant de visiter une maison, regardez ces 4 éléments." },
    { title: "Histoire locale", target: "local", hook: "Un secteur des Ardennes que les acheteurs regardent de près." },
    { title: "Coulisses", target: "vendeurs", hook: "À quoi ressemble réellement une estimation sur le terrain ?" },
    { title: "Vente trop chère", target: "vendeurs", hook: "Pourquoi afficher un prix trop élevé peut ralentir une vente." },
    { title: "Vente dans 6 mois", target: "vendeurs", hook: "Vous pensez vendre dans quelques mois ? Commencez par ceci." }
  ]);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`JML Machine à Mandats v${VERSION} running on port ${PORT}`)))
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    app.listen(PORT, () => console.log(`JML Machine à Mandats v${VERSION} running on port ${PORT} without database`));
  });
