# JML Projet Vendeur

Application JML Immobilier dédiée à l'acquisition, la qualification et au suivi des propriétaires potentiellement vendeurs dans les Ardennes.

## Accès public

Page vendeur :
`/projet-vendeur`

Exemple avec suivi de campagne Facebook :
`/projet-vendeur?campaign=a-la-une`

L'ancienne route `/facebook` redirige automatiquement vers `/projet-vendeur` afin de conserver les anciens liens fonctionnels.

## Architecture

- Express + PostgreSQL
- API REST pour les prospects et les leads
- Qualification et suivi commercial
- Acquisition Facebook avec suivi de campagne
- Lead Magnet avec consentement explicite
- Aucun envoi automatique de message
- JML Prospection (DVF/DPE) reste séparé

## Modules

Tableau de bord · Prospects · Acquisition Facebook · JML Publication · Lead Magnet · Relances · KPI · Intelligence commerciale

## Render

Build : `npm install`  
Start : `npm start`  
Persistance : variable `DATABASE_URL`

La base PostgreSQL existante n'est pas supprimée. L'application utilise ses propres tables `jml_prospects`, `jml_activities` et `jml_leads`.

## Version

Application : 1.7.0
