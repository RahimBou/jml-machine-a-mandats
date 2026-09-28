const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "JML Machine à Mandats",
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières"
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    region: process.env.JML_REGION || "Ardennes",
    sector: process.env.JML_SECTOR || "Charleville-Mézières",
    modules: [
      "Publication",
      "Lead Magnet",
      "Prospects",
      "Qualification IA",
      "CRM",
      "Relances",
      "KPI"
    ]
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`JML Machine à Mandats running on port ${PORT}`);
});
