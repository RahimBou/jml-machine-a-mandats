# JML Machine à Mandats

Application séparée de **JML Prospection** destinée à construire un système d'acquisition et de suivi des mandats pour les Ardennes.

## Architecture prévue

1. JML Publication — contenu local
2. Lead Magnet — capture de prospects
3. Prospects — centralisation
4. Qualification IA — intention et horizon
5. CRM — suivi
6. Relances — suivi non intrusif
7. KPI — mesure des sources et conversions

## Principe de sécurité

Le moteur DVF/DPE de **JML Prospection** reste séparé et n'est pas modifié dans ce projet.

## Déploiement Render

- Runtime : Node
- Build : `npm install`
- Start : `npm start`
- Port : `PORT` fourni par Render

## Statut

Version 0.3.0 : pipeline prospects, qualification par règles, priorités A/B/C et suggestions de relance. Les envois restent manuels.
