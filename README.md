# JML Machine à Mandats — V1.0.0

Reconstruction complète après les problèmes d'interface de la V0.x.

## Architecture
- Express + PostgreSQL
- API REST pour les prospects et les leads
- Aucun stockage métier des prospects dans localStorage
- Navigation centralisée dans \`public/app.js\`
- Aucun \`onclick\` inline dans l'application
- Qualification séparée de l'enregistrement
- Lead Magnet avec consentement explicite
- Aucun envoi automatique de message
- JML Prospection (DVF/DPE) reste séparé

## Modules V1
Tableau de bord · Prospects · JML Publication · Lead Magnet · Relances · KPI

## Render
Build: \`npm install\`
Start: \`npm start\`
Persistance: variable \`DATABASE_URL\`

La base PostgreSQL existante n'est pas supprimée. L'application utilise ses propres tables \`jml_prospects\` et \`jml_leads\`.

## Version
1.0.0
