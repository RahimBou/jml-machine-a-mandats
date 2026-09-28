const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const modules = [
  { id: "dashboard", label: "Tableau de bord", icon: "⌂" },
  { id: "prospects", label: "Prospects", icon: "◎" },
  { id: "publication", label: "JML Publication", icon: "✦" },
  { id: "leadmagnet", label: "Lead Magnet", icon: "↳" },
  { id: "relances", label: "Relances", icon: "↻" },
  { id: "kpi", label: "KPI", icon: "▦" }
];

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "JML Machine à Mandats",
    version: "0.2.0",
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières"
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières",
    modules
  });
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

app.listen(PORT, () => {
  console.log(`JML Machine à Mandats v0.2.0 running on port ${PORT}`);
});
