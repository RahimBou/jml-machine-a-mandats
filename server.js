const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { Pool } = require("pg");
const registerPublicEventsRoute = require("./events");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = "3.4.0";
const BUILD_MARKER = "dvf-postgres-monthly-01";
const DVF_LATEST_YEAR = Number(process.env.CURRENT_DATA_YEAR || 2025);

app.disable("x-powered-by");
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).json({
    ok:true,
    service:"jml-projet-vendeur",
    version:VERSION,
    build:BUILD_MARKER,
    sellerSpace:true,
    persistentDashboard:true
  });
});
app.get("/api/territory-version", (req,res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).json({
    ok:true,
    version:VERSION,
    build:BUILD_MARKER,
    route:"/api/territory-summary",
    expected:"inline-seller-reference"
  });
});
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/projet-vendeur", (req, res) => res.sendFile(path.join(__dirname, "public", "projet-vendeur.html")));
app.get("/espace-vendeur/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "espace-vendeur.html")));
app.get("/facebook", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/projet-vendeur${qs}`);
});
app.use((req,res,next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});
app.get("/vendeur-secteur", (req,res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  res.sendFile(path.join(__dirname, "public", "vendeur-secteur.html"));
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], etag: false, lastModified: false }));

const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
}) : null;

const memory = { prospects: new Map(), leads: new Map(), sellerSpaces: new Map() };
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
registerPublicEventsRoute(app, clean);

const communeMarketCache = new Map();
const IMMO_DATA_API_BASE_URL = String(process.env.IMMO_DATA_API_BASE_URL || "https://api.immo-data.fr").replace(/\/+$/,"");

async function immoDataRequest(endpoint, params = {}) {
  const apiKey = String(process.env.IMMO_DATA_API_KEY || "").trim();
  if (!apiKey) throw new Error("IMMO_DATA_API_KEY non configurée sur Render");
  const url = new URL(IMMO_DATA_API_BASE_URL + endpoint);
  Object.entries(params).forEach(([key,value]) => {
    if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Accept": "application/json",
      "User-Agent": "JML-Projet-Vendeur/3.3.0"
    },
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const detail = payload?.message || payload?.error || ("HTTP " + response.status);
    throw new Error("Immo Data " + response.status + " — " + detail);
  }
  return payload;
}

// Test léger de la clé Render : le géocodage coûte seulement 0,001 €
// et permet de vérifier simultanément l'URL, l'Authorization et la réponse API.
app.get("/api/immo-data/test", async (req,res) => {
  const city = clean(req.query.city || "Charleville-Mézières",100);
  if (!process.env.IMMO_DATA_API_KEY) {
    return res.status(503).json({ok:false,configured:false,error:"IMMO_DATA_API_KEY absente de l'environnement Render."});
  }
  try {
    const data = await immoDataRequest("/v1/geocode", {q:city, geoLevel:"city", limit:1});
    return res.json({
      ok:true,
      configured:true,
      provider:"Immo Data",
      endpoint:"/v1/geocode",
      query:city,
      resultCount:Array.isArray(data) ? data.length : Array.isArray(data?.data) ? data.data.length : null,
      message:"Connexion Immo Data opérationnelle."
    });
  } catch (error) {
    console.error("JML Immo Data test:", error.message);
    return res.status(502).json({ok:false,configured:true,provider:"Immo Data",error:error.message});
  }
});



/* ---------- Territoire : sécurité, risques et environnement ---------- */
const ssmsiSecurityCache = new Map();
let ssmsiSecurityLoadPromise = null;
const SSMSI_SECURITY_URL = "https://static.data.gouv.fr/resources/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/20260709-115942/donnee-data.gouv-2025-geographie2026-produit-le2026-06-25.csv.gz";
const SSMSI_SECURITY_SOURCE = "SSMSI / Ministère de l'Intérieur — données 2025, délinquance enregistrée au lieu de commission";

function parseCsvSemicolonLine(line){
  const out=[]; let value=""; let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){ value+='"'; i++; }
      else quoted=!quoted;
    }else if(ch===";" && !quoted){ out.push(value); value=""; }
    else value+=ch;
  }
  out.push(value);
  return out.map(v=>v.trim());
}
function parseNumericLoose(value){
  const v=String(value??"").trim();
  if(!v || v.toUpperCase()==="NA") return null;
  const n=Number(v.replace(/\s/g,"").replace(",","."));
  return Number.isFinite(n)?n:null;
}
function normalizeSecurityIndicator(name){
  return String(name||"").trim();
}
function securityUnitLabel(indicator){
  return /Cambriolages de logement/i.test(indicator) ? "pour 1 000 logements" : "pour 1 000 habitants";
}
function securityShortLabel(indicator){
  const labels={
    "Cambriolages de logement":"Cambriolages de logement",
    "Vols de véhicule":"Vols de véhicules",
    "Vols dans les véhicules":"Vols dans les véhicules",
    "Destructions et dégradations volontaires":"Dégradations volontaires",
    "Vols sans violence contre des personnes":"Vols sans violence",
    "Violences physiques intrafamiliales":"Violences intrafamiliales",
    "Violences physiques hors cadre familial":"Violences hors cadre familial",
    "Violences sexuelles":"Violences sexuelles",
    "Escroqueries et fraudes aux moyens de paiement":"Escroqueries / fraudes",
    "Usage de stupéfiants":"Usage de stupéfiants",
    "Trafic de stupéfiants":"Trafic de stupéfiants"
  };
  return labels[indicator] || indicator;
}
async function loadSsmsiSecurityDataset(){
  if(ssmsiSecurityLoadPromise) return ssmsiSecurityLoadPromise;
  ssmsiSecurityLoadPromise=(async()=>{
    const response=await fetch(SSMSI_SECURITY_URL,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(45000)});
    if(!response.ok) throw new Error("SSMSI HTTP "+response.status);
    if(!response.body) throw new Error("SSMSI flux indisponible");
    const gunzip=zlib.createGunzip();
    const input=Readable.fromWeb(response.body).pipe(gunzip);
    const rl=readline.createInterface({input,crlfDelay:Infinity});
    let header=null, idx={};
    let loaded=0;
    for await(const line of rl){
      if(!line) continue;
      if(!header){
        header=parseCsvSemicolonLine(line).map(v=>v.replace(/^"|"$/g,""));
        header.forEach((name,i)=>idx[name]=i);
        continue;
      }
      const row=parseCsvSemicolonLine(line);
      const year=String(row[idx.annee]||"");
      if(year!=="2025") continue;
      const code=String(row[idx.CODGEO_2025]||"").trim();
      const indicator=normalizeSecurityIndicator(row[idx.indicateur]);
      if(!code || !indicator) continue;
      if(!ssmsiSecurityCache.has(code)) ssmsiSecurityCache.set(code,{year:2025,indicators:{},population:parseNumericLoose(row[idx.insee_pop]),logements:parseNumericLoose(row[idx.insee_log])});
      const entry=ssmsiSecurityCache.get(code);
      entry.indicators[indicator]={
        label:securityShortLabel(indicator),
        indicator,
        unit:securityUnitLabel(indicator),
        count:parseNumericLoose(row[idx.nombre]),
        rate:parseNumericLoose(row[idx.taux_pour_mille]),
        status:String(row[idx.est_diffuse]||"").trim(),
        available:String(row[idx.est_diffuse]||"").trim()==="diff"
      };
      loaded++;
    }
    return {communes:ssmsiSecurityCache.size,rows:loaded};
  })().catch(error=>{
    ssmsiSecurityLoadPromise=null;
    throw error;
  });
  return ssmsiSecurityLoadPromise;
}
async function getSecurityData(code){
  const cleanCode=String(code||"").trim();
  if(!/^\d{5}$/.test(cleanCode)) return {available:false,year:2025,source:SSMSI_SECURITY_SOURCE,message:"Code commune non disponible."};
  const sourceUrl="https://www.mon-quartier-info.com/securite/"+cleanCode;
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+cleanCode,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const labels=["Destructions et dégradations volontaires","Vols sans violence contre des personnes","Cambriolages de logement","Vols de véhicule","Vols dans les véhicules","Vols d'accessoires sur véhicules","Violences physiques intrafamiliales","Violences physiques hors cadre familial","Violences sexuelles","Escroqueries et fraudes aux moyens de paiement"];
      const indicators=[];
      for(const label of labels){
        const safe=label.replace(/[.*+?^$()|[\]\\]/g,"\\$&");
        const re=new RegExp(safe+"\\s+([0-9\\s]+)\\s+(?:faits|victimes|véhicules)\\s+([0-9]+(?:[.,][0-9]+)?)","i");
        const m=text.match(re);
        if(m) indicators.push({label,indicator:label,count:Number(m[1].replace(/\\s/g,"")),rate:Number(m[2].replace(",",".")),unit:label==="Cambriolages de logement"?"‰ logements":"‰ habitants",available:true});
      }
      if(indicators.length) return {available:true,year:2025,indicators,source:"SSMSI / Ministère de l’Intérieur — via source publique de restitution",sourceUrl,note:"Les chiffres proviennent du SSMSI 2025. Aucun score JML n'est calculé."};
    }
  }catch(error){console.warn("JML sécurité source publique:",error.message);}
  try{
    await loadSsmsiSecurityDataset();
    const record=ssmsiSecurityCache.get(cleanCode);
    if(record){
      const preferred=["Cambriolages de logement","Vols de véhicule","Vols dans les véhicules","Destructions et dégradations volontaires","Vols sans violence contre des personnes","Violences physiques intrafamiliales","Violences physiques hors cadre familial","Violences sexuelles","Escroqueries et fraudes aux moyens de paiement"];
      const indicators=preferred.map(k=>record.indicators[k]).filter(Boolean);
      return {available:true,year:record.year,population:record.population,logements:record.logements,indicators,source:SSMSI_SECURITY_SOURCE,sourceUrl:"https://www.data.gouv.fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales",note:"Faits enregistrés par la police et la gendarmerie. Une donnée non diffusée ne signifie pas zéro."};
    }
  }catch(error){console.warn("JML SSMSI dataset:",error.message);}
  return {available:false,year:2025,source:SSMSI_SECURITY_SOURCE,message:"Données de sécurité temporairement indisponibles."};
}

async function getGeoRisks(code){
  const cleanCode=String(code||"").trim();
  if(!/^\d{5}$/.test(cleanCode)) return {available:false,message:"Code INSEE non disponible."};
  const reportUrl="https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2/"+cleanCode+"/commune/00000";
  try{
    const response=await fetch("https://www.georisques.gouv.fr/api/v1/gaspar/risques?code_insee="+encodeURIComponent(cleanCode),{headers:{"User-Agent":"JML-Projet-Vendeur/3.0","Accept":"application/json"},signal:AbortSignal.timeout(6000)});
    if(response.ok){
      const payload=await response.json();
      const rows=Array.isArray(payload)?payload:(Array.isArray(payload.data)?payload.data:(Array.isArray(payload.resultats)?payload.resultats:[]));
      const labels=[...new Set(rows.map(r=>String(r.libelle||r.nom||r.libelle_risque||r.risque||"").trim()).filter(Boolean))].slice(0,12);
      if(labels.length) return {available:true,source:"Géorisques / BRGM",sourceUrl:"https://www.georisques.gouv.fr/",risks:labels,count:labels.length,note:"Information à l'échelle communale. Vérification à l'adresse/parcelle recommandée."};
    }
  }catch(error){console.warn("JML Géorisques API:",error.message);}
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+cleanCode,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const risks=[];
      const patterns=[["Inondation","inondation"],["Mouvement de terrain","mouvement de terrain"],["Séisme","séisme"],["Transport de marchandises dangereuses","transport de marchandises dangereuses"],["Sécheresse","sécheresse"]];
      for(const [label,pattern] of patterns) if(new RegExp(pattern,"i").test(text)) risks.push(label);
      const m=text.match(/([0-9]+) arrêtés? de catastrophe naturelle/i);
      if(risks.length||m) return {available:true,source:"Géorisques / BRGM — restitution publique",sourceUrl:"https://www.mon-quartier-info.com/commune/"+cleanCode,risks,count:risks.length,catNatCount:m?Number(m[1]):null,note:"Repère communal issu de données Géorisques. Il ne remplace pas un état des risques à l'adresse ou à la parcelle."};
    }
  }catch(error){console.warn("JML risques secours:",error.message);}
  return {available:false,message:"Données Géorisques temporairement indisponibles.",reportUrl};
}

const localEnvironmentCache=new Map();
async function getLocalEnvironment(commune){
  const code=String(commune?.code||"").trim();
  if(!/^\d{5}$/.test(code)) return {available:false,message:"Code commune indisponible."};
  const key=code;
  const cached=localEnvironmentCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+code,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const pick=label=>{const m=text.match(new RegExp(label+"\\s*\\((\\d+)\\)","i"));return m?Number(m[1]):null;};
      const schools=pick("École"),health=pick("Médecin généraliste"),pharmacies=pick("Pharmacie"),shops=pick("Alimentation générale"),postOffices=pick("Bureau ou relais de poste"),stations=pick("Gare de voyageurs");
      const sm=text.match(/([0-9\s]+) équipements et services recensés sur la commune/i);
      const data={available:true,source:"INSEE BPE / Mon Quartier Info",sourceUrl:"https://www.mon-quartier-info.com/commune/"+code,counters:{schools:schools??0,health:health??0,pharmacies:pharmacies??0,shops:shops??0,stations:stations??0,busStops:null,postOffices:postOffices??0,totalServices:sm?Number(sm[1].replace(/\s/g,"")):null},names:{schools:[],health:[],pharmacies:[],shops:[],stations:[]},radiusKm:null,note:"Comptage communal issu principalement de la Base permanente des équipements (INSEE)."};
      localEnvironmentCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data});
      return data;
    }
  }catch(error){console.warn("JML services source publique:",error.message);}
  return {available:false,message:"Les services locaux sont temporairement indisponibles."};
}

const normalizeSearchCity = value => String(value || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLowerCase().replace(/[^a-z0-9 -]/g,"").replace(/\s+/g," ").trim();

function decodeBasicEntities(value){
  return String(value || "")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;|&apos;/gi,"'")
    .replace(/&quot;/gi,'"').replace(/&eacute;/gi,"é").replace(/&egrave;/gi,"è")
    .replace(/&ecirc;/gi,"ê").replace(/&agrave;/gi,"à").replace(/&acirc;/gi,"â")
    .replace(/&ocirc;/gi,"ô").replace(/&ugrave;/gi,"ù").replace(/&ucirc;/gi,"û")
    .replace(/&ccedil;/gi,"ç");
}

async function getCommuneMarketData(city,code){
  const cleanCity=clean(city,100), communeCode=String(code||"").trim();
  const key="pg1|"+normalizeSearchCity(cleanCity)+"|"+communeCode;
  const cached=communeMarketCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return {...cached.data,cache:true};
  const empty={city:cleanCity,found:false,source:"DVF local JML / PostgreSQL",sourceUrl:"https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/",message:"Aucune donnée DVF importée n'est encore disponible pour cette commune.",recentSales:[],recentSalesSource:"PostgreSQL DVF local",nearby:[],history:[],transactions:null,communalPrice:null,housePrice:null,apartmentPrice:null};
  if(!pool||!/^\d{5}$/.test(communeCode)) return empty;
  try{
    const summary=await db(`SELECT COUNT(*)::int AS transactions,percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) AS communal_price,percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) FILTER (WHERE property_type='Maison') AS house_price,percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) FILTER (WHERE property_type='Appartement') AS apartment_price FROM jml_dvf_sales WHERE commune_code=$1 AND sale_date>=CURRENT_DATE-INTERVAL '24 months'`,[communeCode]);
    const recent=await db(`SELECT mutation_id AS id,TO_CHAR(sale_date,'YYYY-MM-DD') AS date,property_type AS type,price::float8 AS price,surface::float8 AS surface,rooms::float8 AS rooms,land_surface::float8 AS land,latitude AS lat,longitude AS lon,address,street,postal_code AS postal,commune_code AS code,commune_name AS city,price_per_m2::float8 AS "pricePerM2",source FROM jml_dvf_sales WHERE commune_code=$1 AND sale_date>=CURRENT_DATE-INTERVAL '24 months' ORDER BY sale_date DESC LIMIT 12`,[communeCode]);
    const history=await db(`SELECT EXTRACT(YEAR FROM sale_date)::int AS year,COUNT(*)::int AS transactions,percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) AS value FROM jml_dvf_sales WHERE commune_code=$1 GROUP BY EXTRACT(YEAR FROM sale_date) ORDER BY year`,[communeCode]);
    const s=summary.rows[0]||{};
    const data={city:cleanCity,found:Number(s.transactions||0)>0,source:"DVF local JML / PostgreSQL",sourceUrl:"https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/",message:Number(s.transactions||0)>0?"Repère communal calculé directement à partir des transactions DVF importées dans PostgreSQL.":"Aucune transaction DVF importée n'est disponible pour cette commune.",recentSales:recent.rows,recentSalesSource:"DVF local JML / PostgreSQL",nearby:[],history:history.rows.map(x=>({year:x.year,value:x.value!=null?Math.round(Number(x.value)):null,transactions:x.transactions})),transactions:Number(s.transactions||0)||null,communalPrice:s.communal_price!=null?Math.round(Number(s.communal_price)):null,housePrice:s.house_price!=null?Math.round(Number(s.house_price)):null,apartmentPrice:s.apartment_price!=null?Math.round(Number(s.apartment_price)):null,period:"DVF importé / 24 derniers mois"};
    communeMarketCache.set(key,{expiresAt:Date.now()+6*60*60*1000,data}); return {...data,cache:false};
  }catch(error){console.warn("JML PostgreSQL DVF market:",error.message);return {...empty,message:"La base DVF PostgreSQL est temporairement indisponible."};}
}
async function getLocalDvfComparables(origin,maxKm=3){
  if(!pool||!origin)return [];
  const lat=Number(origin.lat),lon=Number(origin.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon))return [];
  const dLat=maxKm/111,dLon=maxKm/(111*Math.max(0.2,Math.cos(lat*Math.PI/180)));
  const result=await db(`SELECT mutation_id AS id,TO_CHAR(sale_date,'YYYY-MM-DD') AS date,property_type AS type,price::float8 AS price,surface::float8 AS surface,rooms::float8 AS rooms,land_surface::float8 AS land,latitude AS lat,longitude AS lon,address,street,postal_code AS postal,commune_code AS code,commune_name AS city,price_per_m2::float8 AS "pricePerM2",source FROM jml_dvf_sales WHERE sale_date>=CURRENT_DATE-INTERVAL '24 months' AND property_type IN ('Maison','Appartement') AND latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4 ORDER BY sale_date DESC LIMIT 3000`,[lat-dLat,lat+dLat,lon-dLon,lon+dLon]);
  return result.rows;
}

function buildSellerReference(market,property){
  const type=String(property?.propertyType||"").toLowerCase();
  const isApartment=/appartement|studio|duplex|loft/i.test(type);
  const isHouse=/maison/i.test(type);
  const typeLabel=isApartment?"Appartement":isHouse?"Maison":"Tous biens";
  const base= isApartment?Number(market?.apartmentPrice):isHouse?Number(market?.housePrice):Number(market?.communalPrice||market?.price);
  const surface=Number(property?.surface);
  const hasBase=Number.isFinite(base)&&base>0;
  const hasSurface=Number.isFinite(surface)&&surface>0;
  const raw=hasBase&&hasSurface?Math.round(base*surface):null;
  const low=raw!==null?Math.round(raw*0.85):null;
  const high=raw!==null?Math.round(raw*1.15):null;
  return {
    available:hasBase,
    type:typeLabel,
    basePriceM2:hasBase?base:null,
    surface:hasSurface?surface:null,
    referenceValue:raw,
    range:{low,high,marginPct:15},
    transactions:Number.isFinite(Number(market?.transactions))?Number(market.transactions):null,
    history:Array.isArray(market?.history)?market.history:[],
    comparables:market?.comparables||{sales:[],sameStreet:[],median:null,matchCount:0},
    explanation:hasBase&&hasSurface
      ? "Repère mathématique construit à partir du prix médian du type de bien et de la surface renseignée. La fourchette de ±15 % sert à matérialiser l’écart possible autour du repère ; elle ne constitue pas une estimation certifiée."
      : "Le repère sera calculé dès que le type de bien et la surface seront suffisamment renseignés."
  };
}

async function getNearbyCommunes(commune){
  const dep=String(commune?.departement?.code||"08");
  try{
    const url="https://geo.api.gouv.fr/departements/"+encodeURIComponent(dep)+"/communes?fields=nom,code,population,centre&format=json";
    const response=await fetch(url,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(6000)});
    if(!response.ok) throw new Error("Geo API HTTP "+response.status);
    const rows=await response.json(),origin=commune?.centre?.coordinates;
    if(!Array.isArray(origin)||origin.length<2) return [];
    const o={lon:Number(origin[0]),lat:Number(origin[1])};
    return rows.map(x=>{
      const p=x?.centre?.coordinates;if(!Array.isArray(p)||p.length<2)return null;
      const d=haversineKm(o,{lon:Number(p[0]),lat:Number(p[1])});
      return d!=null?{name:x.nom,code:x.code,population:x.population,distanceKm:Number(d.toFixed(1))}:null;
    }).filter(Boolean).filter(x=>x.code!==commune.code&&x.distanceKm<=20).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,6);
  }catch(error){
    console.warn("JML communes proches Geo API:",error.message);
    try{
      const response=await fetch("https://www.mon-quartier-info.com/commune/"+String(commune?.code||""),{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
      if(response.ok){
        const html=await response.text(),out=[],seen=new Set();
        const re=/<a[^>]+href=["\']\/commune\/(\d{5})["\'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while((m=re.exec(html))&&out.length<6){
          const code=m[1],name=stripHtml(m[2]);
          if(code!==String(commune?.code||"")&&!seen.has(code)&&name){seen.add(code);out.push({name,code,population:null,distanceKm:null});}
        }
        return out;
      }
    }catch(fallbackError){console.warn("JML communes proches secours:",fallbackError.message);}
    return [];
  }
}

async function resolveTerritoryCommune(city,address){
  const requestedCity=String(city||"").trim();
  const requestedAddress=String(address||"").trim();
  if(!requestedCity) return null;

  const postalMatch=requestedAddress.match(/\b(\d{5})\b/) || requestedCity.match(/\b(\d{5})\b/);
  const postal=postalMatch ? postalMatch[1] : "";
  const cityName=requestedCity
    .replace(/\b\d{5}\b/g," ")
    .replace(/\s+/g," ")
    .trim();

  const normalizeName=value=>String(value||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/['’\-]/g," ")
    .replace(/\s+/g," ").trim()
    .replace(/^(le|la|les|l|d|de|du|des)\s+/,"");

  const wanted=normalizeName(cityName);

  const chooseCandidate=(rows)=>{
    const list=Array.isArray(rows)?rows.filter(Boolean):[];
    if(!list.length) return null;

    const exact=list.find(row=>normalizeName(row.nom)===wanted);
    const starts=list.find(row=>{
      const n=normalizeName(row.nom);
      return n===wanted || n.startsWith(wanted+" ") || wanted.startsWith(n+" ");
    });
    const selected=exact||starts||list[0];
    if(!selected || !/^\d{5}$/.test(String(selected.code||""))) return null;

    const centre=selected.centre&&Array.isArray(selected.centre.coordinates)
      ?selected.centre.coordinates:[null,null];

    return {
      nom:String(selected.nom||cityName||requestedCity).trim(),
      code:String(selected.code).trim(),
      population:Number.isFinite(Number(selected.population))?Number(selected.population):null,
      surface:Number.isFinite(Number(selected.surface))?Number(selected.surface):null,
      centre:{type:"Point",coordinates:centre},
      departement:selected.departement||{code:String(selected.code).slice(0,2)},
      region:selected.region||null,
      epci:selected.epci||null
    };
  };

  if(postal){
    try{
      const url="https://geo.api.gouv.fr/communes?codePostal="+encodeURIComponent(postal)
        +"&fields=nom,code,population,surface,centre,departement,region,epci&format=json";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(5000)
      });
      if(response.ok){
        const rows=await response.json();
        const selected=chooseCandidate(rows);
        if(selected){
          console.log("JML commune résolue par code postal:",postal,selected.nom,selected.code);
          return selected;
        }
      }
    }catch(error){
      console.warn("JML résolution commune par code postal:",error.message);
    }
  }

  if(cityName){
    try{
      const url="https://geo.api.gouv.fr/communes?nom="+encodeURIComponent(cityName)
        +"&boost=population&fields=nom,code,population,surface,centre,departement,region,epci&format=json";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(5000)
      });
      if(response.ok){
        const rows=await response.json();
        const selected=chooseCandidate(rows);
        if(selected){
          console.log("JML commune résolue par nom:",cityName,selected.code);
          return selected;
        }
      }
    }catch(error){
      console.warn("JML résolution commune par nom:",error.message);
    }
  }

  const queries=[];
  const addQuery=value=>{
    const q=String(value||"").trim();
    if(q&&!queries.includes(q)) queries.push(q);
  };
  addQuery([requestedAddress,cityName].filter(Boolean).join(", "));
  addQuery([cityName,postal].filter(Boolean).join(", "));
  addQuery(cityName);

  for(const query of queries){
    try{
      const url="https://data.geopf.fr/geocodage/search?q="+encodeURIComponent(query)+"&limit=5";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(6000)
      });
      if(!response.ok) continue;
      const payload=await response.json();
      const features=Array.isArray(payload?.features)?payload.features:[];
      for(const feature of features){
        const p=feature?.properties||{};
        const code=String(p.citycode||p.cityCode||p.citycode_insee||"").trim();
        if(!/^\d{5}$/.test(code)) continue;
        const coords=feature?.geometry?.coordinates;
        const label=String(p.label||p.name||cityName).trim();
        const nom=String(p.city||p.commune||cityName).trim()||cityName;
        return {
          nom,code,population:null,surface:null,
          centre:{type:"Point",coordinates:Array.isArray(coords)&&coords.length>=2?coords:[null,null]},
          departement:{code:code.slice(0,2)},region:null,epci:null,
          geocodedLabel:label
        };
      }
    }catch(error){
      console.warn("JML résolution commune IGN:",query,error.message);
    }
  }

  return null;
}

app.get("/api/commune-market", async (req,res) => {
  const city=clean(req.query.city,100);
  if(!city) return res.status(400).json({
    ok:false,
    code:"JML-MARKET-400",
    error:"Commune requise."
  });
  try{
    const commune=await resolveTerritoryCommune(city,"");
    if(!commune) return res.status(422).json({
      ok:false,
      code:"JML-MARKET-422",
      error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
    });
    const market=await getCommuneMarketData(commune.nom,commune.code);
    return res.json({
      ok:true,
      ...market,
      commune:{code:commune.code,nom:commune.nom}
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    console.error("JML commune-market:",detail);
    return res.status(500).json({
      ok:false,
      code:"JML-MARKET-500",
      error:"Erreur lors du chargement du marché communal.",
      detail
    });
  }
});

app.get("/api/territory-commune", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  if(!city) return res.status(400).json({ok:false,code:"JML-COMMUNE-400",error:"Commune requise."});
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune) return res.status(422).json({
      ok:false,code:"JML-COMMUNE-422",
      error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
    });
    return res.json({
      ok:true,commune,
      source:"Géo API / Géoplateforme",
      diagnostics:{resolver:"geo.api.gouv.fr puis Géoplateforme",code:commune.code,name:commune.nom}
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    console.error("JML territory-commune:",detail);
    return res.status(500).json({ok:false,code:"JML-COMMUNE-500",error:"Erreur lors de la résolution de la commune.",detail});
  }
});

function normalizeAddress(value){
  return normalizeSearchCity(String(value||"").replace(/[0-9]+/g," ").replace(/\s+/g," "));
}
const geocodeCache=new Map();
async function geocodeAddress(address,city){
  const raw=String(address||"").trim(), commune=String(city||"").trim();
  if(!raw||!commune) return null;
  const key=normalizeSearchCity(raw+", "+commune);
  const cached=geocodeCache.get(key);
  if(cached && cached.expiresAt>Date.now()) return cached.value;
  try{
    const q=encodeURIComponent(raw+", "+commune);
    const response=await fetch("https://data.geopf.fr/geocodage/search?q="+q+"&limit=5",{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/3.4.0"},
      signal:AbortSignal.timeout(6000)
    });
    if(!response.ok) return null;
    const payload=await response.json();
    const feature=(Array.isArray(payload?.features)?payload.features:[]).find(x=>Array.isArray(x?.geometry?.coordinates)&&x.geometry.coordinates.length>=2);
    if(!feature) return null;
    const [lon,lat]=feature.geometry.coordinates.map(Number);
    const value=Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon,label:String(feature?.properties?.label||"").trim()}:null;
    geocodeCache.set(key,{expiresAt:Date.now()+24*60*60*1000,value});
    return value;
  }catch(error){ console.warn("JML géocodage adresse:",error.message); return null; }
}
function haversineKm(a,b){
  const lat1=Number(a?.lat),lon1=Number(a?.lon),lat2=Number(b?.lat),lon2=Number(b?.lon);
  if(![lat1,lon1,lat2,lon2].every(Number.isFinite)) return null;
  const r=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return r*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));
}
function classifyDvfType(value,code){
  const v=String(value||"").toLowerCase(), c=String(code||"").toLowerCase();
  if(/appartement|apartment/.test(v)||c==="2") return "Appartement";
  if(/maison|house/.test(v)||c==="1") return "Maison";
  return null;
}
function parseSaleDate(v){
  if(v instanceof Date&&!Number.isNaN(v.getTime())) return v;
  const raw=String(v??"").trim(); if(!raw) return null;
  const direct=new Date(raw); if(!Number.isNaN(direct.getTime())) return direct;
  const normalized=raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  const fr=normalized.match(/^(\d{1,2})[\s/-]+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)[a-z.]*[\s/-]+(\d{4})$/i);
  if(fr){
    const months={janvier:0,janv:0,fevrier:1,fevr:1,mars:2,avril:3,avr:3,mai:4,juin:5,juillet:6,juil:6,aout:7,septembre:8,sept:8,octobre:9,oct:9,novembre:10,nov:10,decembre:11,dec:11};
    const d=new Date(Number(fr[3]),months[fr[2]],Number(fr[1]));
    return d.getFullYear()===Number(fr[3])&&d.getMonth()===months[fr[2]]&&d.getDate()===Number(fr[1])?d:null;
  }
  return null;
}
async function buildComparableSales(market,property){
  const city=String(property?.city||market?.city||"").trim();
  const typeWanted=classifyDvfType(property?.propertyType,"");
  const surface=Number(property?.surface), rooms=Number(property?.rooms);
  const origin=await geocodeAddress(property?.address,city);
  if(!origin) return {sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,totalCandidates:0,radiusKm:null,searchScope:"Adresse non géolocalisée",origin:null,message:"L'adresse n'a pas pu être géolocalisée précisément."};
  const tiers=[{radius:800,months:12,label:"800 m / 12 mois"},{radius:1500,months:18,label:"1,5 km / 18 mois"},{radius:3000,months:24,label:"3 km / 24 mois"}];
  const local=await getLocalDvfComparables(origin,3);
  const seen=new Set(), candidates=[];
  const now=Date.now();
  const streetKey=v=>normalizeAddress(v).replace(/\b\d+\b/g,"").trim();
  const ageMonths=v=>{const d=parseSaleDate(v);return d?Math.max(0,(now-d.getTime())/(30.4375*86400000)):99;};
  const scoreSale=(sale,tier)=>{
    if(typeWanted&&classifyDvfType(sale.type,sale.codtypbien||"")!==typeWanted) return null;
    const dist=Number(sale.distanceKm); if(!Number.isFinite(dist)||dist>tier.radius/1000) return null;
    const gap=Number.isFinite(surface)&&surface>0&&Number(sale.surface)>0?Math.abs(Number(sale.surface)-surface)/surface:null;
    if(gap!==null&&gap>0.30)return null;
    const saleRooms=Number(sale.rooms); if(Number.isFinite(rooms)&&rooms>0&&Number.isFinite(saleRooms)&&saleRooms>0&&Math.abs(saleRooms-rooms)>2)return null;
    const age=ageMonths(sale.date); if(age>tier.months)return null;
    const distanceScore=Math.max(0,1-dist/(tier.radius/1000))*30;
    const recencyScore=Math.max(0,1-age/tier.months)*25;
    const surfaceScore=gap===null?12.5:Math.max(0,1-gap/0.30)*25;
    const roomsScore=Number.isFinite(rooms)&&rooms>0&&Number.isFinite(saleRooms)&&saleRooms>0?Math.max(0,1-Math.abs(saleRooms-rooms)/2)*10:5;
    const sameStreet=streetKey(sale.address)===streetKey(property?.address);
    const scoreRaw=distanceScore+recencyScore+surfaceScore+roomsScore+(sameStreet?10:0)+(Number.isFinite(Number(sale.pricePerM2))?10:0);
    return {...sale,score:Number(Math.min(100,scoreRaw/110*100).toFixed(1)),sameStreet,surfaceGap:gap,ageMonths:Number(age.toFixed(1)),tier:tier.label};
  };
  const sourceRows=[...(Array.isArray(market?.recentSales)?market.recentSales:[]),...(Array.isArray(local)?local:[])];
  for(const sale of sourceRows){
    const id=String(sale.id||[sale.date,sale.address,sale.price,sale.surface].join("|"));
    if(seen.has(id))continue; seen.add(id);
    const distanceKm=haversineKm(origin,{lat:Number(sale.lat),lon:Number(sale.lon)});
    if(distanceKm==null)continue;
    const normalized={...sale,distanceKm:Number(distanceKm.toFixed(3)),pricePerM2:Number(sale.pricePerM2||sale.price_per_m2||0)||null};
    for(const tier of tiers){const x=scoreSale(normalized,tier);if(x){candidates.push(x);break;}}
  }
  candidates.sort((a,b)=>b.score-a.score);
  const display=candidates.slice(0,12);
  const values=display.map(x=>Number(x.pricePerM2)).filter(Number.isFinite).sort((a,b)=>a-b);
  const median=values.length?(values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2):null;
  const weightedDen=display.reduce((s,x)=>s+Math.max(0.1,x.score),0);
  const weightedPriceM2=weightedDen?display.reduce((s,x)=>s+Number(x.pricePerM2||0)*Math.max(0.1,x.score),0)/weightedDen:null;
  const radiusKm=display.length?Math.max(...display.map(x=>x.distanceKm)):null;
  return {
    sales:display,
    sameStreet:display.filter(s=>s.sameStreet),
    median:median!=null?Math.round(median):null,
    weightedPriceM2:weightedPriceM2!=null?Math.round(weightedPriceM2):null,
    matchCount:display.length,totalCandidates:candidates.length,radiusKm,
    searchScope:display.length?display[display.length-1].tier:"Aucun comparable répondant aux critères",
    origin,
    source:"DVF local JML / PostgreSQL",
    method:"Transactions DVF importées en base PostgreSQL ; type strict, récence ≤24 mois, surface ±30 %, pièces ±2, proximité et récence pondérées.",
    engineVersion:"8.0.0-PG-DVF",
    diagnostics:{postgresRows:local.length,marketRows:Array.isArray(market?.recentSales)?market.recentSales.length:0}
  };
}

app.get("/api/territory-summary", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  const propertyType=clean(req.query.propertyType,60);
  const surface=clean(req.query.surface,40);
  const rooms=clean(req.query.rooms,40);
  if(!city) return res.status(400).json({ok:false,error:"Commune requise."});

  let stage="resolve-commune";
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune){
      console.warn("JML territory-summary: commune introuvable",{city,address});
      return res.status(422).json({
        ok:false,
        error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
      });
    }

    stage="market";
    let market={
      city:commune.nom,found:false,source:"Données publiques",
      sourceUrl:"https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres/",
      message:"Les données de marché sont temporairement indisponibles.",
      recentSales:[],recentSalesSource:null,history:[],transactions:null,
      communalPrice:null,housePrice:null,apartmentPrice:null,nearby:[]
    };
    try{
      market=await getCommuneMarketData(commune.nom,commune.code);
    }catch(error){
      console.warn("JML market isolated:",error.message);
    }

    stage="comparables";
    let comparable={
      sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,
      totalCandidates:0,radiusKm:null,searchScope:"Non disponible",origin:null,
      message:"Les comparables seront recherchés dès que l'adresse pourra être géolocalisée."
    };
    try{
      comparable=await Promise.race([
        buildComparableSales(market,{address,propertyType,surface,rooms,city:commune.nom}),
        new Promise(resolve=>setTimeout(()=>resolve({
          sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,totalCandidates:0,
          radiusKm:null,searchScope:"Recherche trop lente — données communales conservées",origin:null,
          message:"La recherche fine autour de l’adresse a dépassé le délai. Les données communales restent disponibles."
        }),15000))
      ]);
    }catch(error){
      console.warn("JML comparables isolated:",error.message);
      comparable.message="La recherche de comparables est temporairement indisponible.";
    }

    let nearby=[];
    try{
      nearby=await getNearbyCommunes(commune);
    }catch(error){
      console.warn("JML nearby isolated:",error.message);
    }

    stage="seller-reference";
    // Calcul du repère vendeur directement ici.
    // On ne dépend plus de buildSellerReference() afin qu'une erreur interne
    // de cette fonction ne puisse plus faire tomber Mon secteur.
    const propertyTypeText=String(propertyType||"").toLowerCase();
    const sellerIsApartment=/appartement|studio|duplex|loft/i.test(propertyTypeText);
    const sellerIsHouse=/maison/i.test(propertyTypeText);
    const sellerType=sellerIsApartment?"Appartement":sellerIsHouse?"Maison":"Tous biens";
    const sellerBase=sellerIsApartment
      ? Number(market?.apartmentPrice)
      : sellerIsHouse
        ? Number(market?.housePrice)
        : Number(market?.communalPrice);
    const sellerSurface=Number(surface);
    const sellerHasBase=Number.isFinite(sellerBase)&&sellerBase>0;
    const sellerHasSurface=Number.isFinite(sellerSurface)&&sellerSurface>0;
    const sellerValue=sellerHasBase&&sellerHasSurface?Math.round(sellerBase*sellerSurface):null;
    const sellerReference={
      available:sellerHasBase,
      type:sellerType,
      basePriceM2:sellerHasBase?sellerBase:null,
      surface:sellerHasSurface?sellerSurface:null,
      referenceValue:sellerValue,
      range:{
        low:sellerValue!==null?Math.round(sellerValue*0.85):null,
        high:sellerValue!==null?Math.round(sellerValue*1.15):null,
        marginPct:15
      },
      transactions:Number.isFinite(Number(market?.transactions))?Number(market.transactions):null,
      history:Array.isArray(market?.history)?market.history:[],
      comparables:comparable,
      explanation:sellerHasBase&&sellerHasSurface
        ?"Repère mathématique construit à partir du prix médian du type de bien et de la surface renseignée. Il ne constitue pas une estimation certifiée."
        :"Le repère personnalisé sera calculé dès que le type de bien et les données de marché seront disponibles."
    };

    return res.json({
      ok:true,version:VERSION,build:BUILD_MARKER,commune,
      market:{...market,comparables},sellerReference,nearby,
      source:"API Géo + Géoplateforme IGN/BAN + DVF PostgreSQL",
      diagnostics:{
        communeResolver:"geo.api.gouv.fr par code postal/nom, puis Géoplateforme",
        communeCode:commune.code,communeName:commune.nom,
        market:!!market?.found,comparables:!!comparable,
        nearby:Array.isArray(nearby),
        marketSource:market?.source||null,
        marketRows:Array.isArray(market?.recentSales)?market.recentSales.length:0
      }
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    const code="JML-TERRITORY-500";
    console.error("JML territory-summary fatal:",{code,stage,detail,stack:error?.stack});
    return res.status(500).json({
      ok:false,
      error:"Erreur interne du module Mon secteur.",
      code,
      stage,
      detail,
      version:VERSION,
      build:BUILD_MARKER,
      diagnostics:{
        stage,
        likelySource:stage==="resolve-commune"?"Géo API / Géoplateforme":stage==="market"?"Marché / DVF PostgreSQL":stage==="comparables"?"Géocodage adresse / DVF PostgreSQL":"Calcul Mon secteur"
      }
    });
  }
});


const nearbyAssetsCache=new Map();

async function getGoogleNearbyAssets(lat,lon){
  const apiKey=String(process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||"").trim();
  if(!apiKey) return {
    available:false,configured:false,code:"JML-GOOGLE-NOT-CONFIGURED",
    source:"Google Places (New)",
    message:"Google Places n'est pas configuré sur Render."
  };
  const la=Number(lat),lo=Number(lon);
  const includedTypes=[
    "school","primary_school","secondary_school","university","college","kindergarten",
    "pharmacy","doctor","medical_clinic","hospital",
    "supermarket","grocery_store","convenience_store","shopping_mall",
    "bus_station","train_station","transit_station","parking",
    "park","playground","post_office","bank","library","restaurant","cafe"
  ];
  try{
    const response=await fetch("https://places.googleapis.com/v1/places:searchNearby",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Goog-Api-Key":apiKey,
        "X-Goog-FieldMask":"places.displayName,places.location,places.types"
      },
      body:JSON.stringify({
        includedTypes,
        maxResultCount:20,
        rankPreference:"DISTANCE",
        locationRestriction:{circle:{center:{latitude:la,longitude:lo},radius:1500}}
      }),
      signal:AbortSignal.timeout(9000)
    });
    const body=await response.text();
    let payload={};
    try{payload=body?JSON.parse(body):{};}catch(_){}
    if(!response.ok){
      const detail=String(payload?.error?.message||body||("HTTP "+response.status)).slice(0,350);
      throw new Error("Google Places HTTP "+response.status+" — "+detail);
    }
    const categories={
      schools:{label:"Écoles & établissements",count:0,items:[]},
      commerces:{label:"Commerces de proximité",count:0,items:[]},
      transport:{label:"Transports & stationnement",count:0,items:[]},
      parks:{label:"Parcs, jeux & loisirs",count:0,items:[]},
      health:{label:"Santé",count:0,items:[]},
      services:{label:"Services du quotidien",count:0,items:[]}
    };
    const mapType=(types)=>{
      const t=Array.isArray(types)?types:[];
      if(t.some(x=>["school","primary_school","secondary_school","university","college","kindergarten"].includes(x))) return "schools";
      if(t.some(x=>["supermarket","grocery_store","convenience_store","shopping_mall"].includes(x))) return "commerces";
      if(t.some(x=>["bus_station","train_station","transit_station","parking"].includes(x))) return "transport";
      if(t.some(x=>["park","playground"].includes(x))) return "parks";
      if(t.some(x=>["pharmacy","doctor","medical_clinic","hospital"].includes(x))) return "health";
      return "services";
    };
    const distance=(p)=>{
      const plat=Number(p?.location?.latitude),plon=Number(p?.location?.longitude);
      const d=haversineKm({lat:la,lon:lo},{lat:plat,lon:plon});
      return d==null?999:d;
    };
    for(const place of (Array.isArray(payload?.places)?payload.places:[])){
      const d=distance(place),cat=mapType(place?.types);
      if(d>1.5||!categories[cat]) continue;
      const name=String(place?.displayName?.text||"Équipement Google").trim();
      categories[cat].count++;
      if(categories[cat].items.length<5) categories[cat].items.push({name,distanceKm:Number(d.toFixed(2))});
    }
    Object.values(categories).forEach(x=>x.items.sort((a,b)=>a.distanceKm-b.distanceKm));
    return {
      available:true,configured:true,provider:"Google Places (New)",
      source:"Google Places (New)",radiusKm:1.5,categories
    };
  }catch(error){
    return {
      available:false,configured:true,code:"JML-GOOGLE-PLACES",
      source:"Google Places (New)",
      message:"Google Places a répondu avec une erreur.",
      detail:String(error?.message||error||"Erreur").slice(0,350)
    };
  }
}

async function getNearbyAssets(lat,lon){
  const la=Number(lat),lo=Number(lon);
  if(!Number.isFinite(la)||!Number.isFinite(lo)) return {
    available:false,code:"JML-ASSET-NO-COORDS",
    message:"Coordonnées de l'adresse indisponibles."
  };
  const key=la.toFixed(5)+","+lo.toFixed(5);
  const cached=nearbyAssetsCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  const q=`[out:json][timeout:8];
(
  nwr(around:1500,${la},${lo})[amenity~"^(school|kindergarten|childcare|college|university|pharmacy|doctors|clinic|hospital|post_office|bank|library|restaurant|cafe|parking)$"];
  nwr(around:1500,${la},${lo})[shop];
  nwr(around:1500,${la},${lo})[highway=bus_stop];
  nwr(around:1500,${la},${lo})[railway~"^(station|halt|tram_stop)$"];
  nwr(around:1500,${la},${lo})[leisure~"^(park|playground|sports_centre|pitch|garden)$"];
  nwr(around:1500,${la},${lo})[tourism=picnic_site];
);
out center tags;`;
  const errors=[];
  try{
    const endpoints=[
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];
    let payload=null,usedEndpoint=null;
    for(const endpoint of endpoints){
      try{
        const response=await fetch(endpoint,{
          method:"POST",
          headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.3.2 (mon-secteur)"},
          body:"data="+encodeURIComponent(q),
          signal:AbortSignal.timeout(8000)
        });
        if(!response.ok) throw new Error("Overpass HTTP "+response.status);
        payload=await response.json(); usedEndpoint=endpoint; break;
      }catch(error){errors.push(endpoint+" → "+String(error?.message||error));}
    }
    if(!payload) throw new Error("Aucune instance Overpass disponible");
    const elements=Array.isArray(payload?.elements)?payload.elements:[];
    const out={
      available:true,source:"OpenStreetMap / Overpass",provider:"OpenStreetMap",
      radiusKm:1.5,categories:{
        schools:{label:"Écoles & établissements",count:0,items:[]},
        commerces:{label:"Commerces de proximité",count:0,items:[]},
        transport:{label:"Transports & stationnement",count:0,items:[]},
        parks:{label:"Parcs, jeux & loisirs",count:0,items:[]},
        health:{label:"Santé",count:0,items:[]},
        services:{label:"Services du quotidien",count:0,items:[]}
      }
    };
    const add=(cat,name,dist)=>{const x=out.categories[cat];if(!x)return;x.count++;if(x.items.length<5)x.items.push({name:name||"Équipement sans nom",distanceKm:Number(dist.toFixed(2))});};
    const distance=(e)=>{const p=e?.center||e,x=Number(p?.lon??e?.lon),y=Number(p?.lat??e?.lat);const d=haversineKm({lat:la,lon:lo},{lat:y,lon:x});return d==null?999:d;};
    for(const e of elements){
      const t=e?.tags||{},d=distance(e),name=String(t.name||t.operator||"").trim();
      if(d>1.5)continue;
      if(["school","kindergarten","childcare","college","university"].includes(t.amenity))add("schools",name,d);
      else if(t.shop)add("commerces",name,d);
      else if(t.highway==="bus_stop"||["station","halt","tram_stop"].includes(t.railway)||t.amenity==="parking")add("transport",name,d);
      else if(["park","playground","sports_centre","pitch","garden"].includes(t.leisure)||t.tourism==="picnic_site")add("parks",name,d);
      else if(["pharmacy","doctors","clinic","hospital"].includes(t.amenity))add("health",name,d);
      else if(["post_office","bank","library","restaurant","cafe"].includes(t.amenity))add("services",name,d);
    }
    Object.values(out.categories).forEach(x=>x.items.sort((a,b)=>a.distanceKm-b.distanceKm));
    out.endpoint=usedEndpoint;
    nearbyAssetsCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data:out});
    return out;
  }catch(error){
    console.warn("JML équipements OSM:",error.message);
    const google=await getGoogleNearbyAssets(la,lo);
    if(google.available) return google;
    return {
      available:false,code:"JML-ASSET-SOURCES",
      source:"OpenStreetMap / Overpass → Google Places",
      message:"Les sources d'équipements ont échoué.",
      diagnostics:[
        ...errors.map(x=>({source:"OpenStreetMap / Overpass",code:"JML-OVERPASS",detail:x})),
        {source:"Google Places (New)",code:google.code||"JML-GOOGLE",detail:google.detail||google.message||"Non configuré"}
      ]
    };
  }
}

app.get("/api/territory-assets", async (req,res) => {
  let lat=Number(req.query.lat), lon=Number(req.query.lon);
  const address=clean(req.query.address,180);
  const city=clean(req.query.city,100);
  try{
    // Ne dépend plus de territory-summary : le bloc "Atouts" doit pouvoir fonctionner seul.
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      const geo=await geocodeAddress(address,city);
      if(!geo) return res.status(404).json({ok:false,available:false,error:"Adresse non géolocalisée.",message:"L'adresse n'a pas pu être géolocalisée précisément."});
      lat=Number(geo.lat); lon=Number(geo.lon);
    }
    const data=await getNearbyAssets(lat,lon);
    return res.json({ok:true,lat,lon,...data});
  }catch(error){
    console.warn("JML territory-assets:",error.message);
    return res.status(502).json({ok:false,available:false,error:"Équipements locaux temporairement indisponibles.",message:"Le service cartographique n'a pas répondu. Une nouvelle tentative est possible."});
  }
});

app.get("/api/territory-enrichment", async (req,res) => {
  const code=clean(req.query.code,10);
  const lat=Number(req.query.lat);
  const lon=Number(req.query.lon);
  if(!/^\d{5}$/.test(code)) return res.status(400).json({ok:false,error:"Code commune requis."});
  try{
    const commune={code,centre:{coordinates:[lon,lat]}};
    const [security,risks,environment]=await Promise.all([
      Promise.race([getSecurityData(code),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les données SSMSI prennent trop de temps à répondre.",year:2025}),9000))]),
      Promise.race([getGeoRisks(code),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les données Géorisques sont temporairement indisponibles."}),5000))]),
      Promise.race([getLocalEnvironment(commune),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les services locaux sont temporairement indisponibles."}),5000))])
    ]);
    return res.json({ok:true,security,risks,environment});
  }catch(error){
    console.warn("JML territory-enrichment:",error.message);
    return res.status(502).json({ok:false,error:"Enrichissements territoriaux temporairement indisponibles."});
  }
});

const cleanEmail = v => String(v ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"").trim().slice(0,180);
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(v));
const toBoolean = v => v === true || v === "true" || v === 1 || v === "1";
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function sendLeadConfirmationEmail(lead, sellerSpaceUrl = "") {
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
    "Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.\n\n" + (sellerSpaceUrl ? "Votre espace vendeur personnel : " + sellerSpaceUrl + "\n\n" : "") +
    "À bientôt,\nJML Immobilier\nVotre projet, notre engagement";
  const safeName = firstName.replace(/[&<>"]/g, "");
  const html = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#f5f1e8;font-family:Arial,sans-serif;color:#26352f\">" +
    "<div style=\"max-width:620px;margin:30px auto;padding:0 16px\">" +
    "<div style=\"background:#173b32;padding:22px 24px;border-radius:12px 12px 0 0;color:#fff\"><div style=\"font-size:22px;font-weight:700\">JML Immobilier</div><div style=\"margin-top:5px;color:#d9bd72;font-size:13px\">VOTRE PROJET, NOTRE ENGAGEMENT</div></div>" +
    "<div style=\"background:#fff;padding:28px 24px;border-radius:0 0 12px 12px\"><p>Bonjour " + safeName + ",</p>" +
    "<p>Nous avons bien reçu votre demande concernant votre projet immobilier dans les Ardennes.</p>" +
    "<p>Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.</p>" + (sellerSpaceUrl ? '<p style="margin:22px 0"><a href="' + sellerSpaceUrl.replace(/[&<>"]/g,"") + '" style="display:inline-block;padding:12px 18px;background:#d8bb7a;color:#173b32;text-decoration:none;border-radius:8px;font-weight:700">Ouvrir mon espace vendeur →</a></p>' : "") +
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

    CREATE TABLE IF NOT EXISTS jml_appointment_requests (
      id TEXT PRIMARY KEY,
      prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      requested_at TIMESTAMPTZ NOT NULL,
      requested_location TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'À traiter',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS jml_seller_spaces (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL UNIQUE,
      prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
      city TEXT,
      address TEXT,
      property_type TEXT,
      horizon TEXT,
      surface TEXT,
      rooms TEXT,
      dpe TEXT,
      terrain TEXT,
      checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS jml_dvf_sales (
      id BIGSERIAL PRIMARY KEY, mutation_id TEXT NOT NULL, sale_date DATE,
      property_type TEXT NOT NULL, price NUMERIC NOT NULL, surface NUMERIC NOT NULL,
      rooms NUMERIC, land_surface NUMERIC, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
      address TEXT, street TEXT, postal_code TEXT, commune_code TEXT, commune_name TEXT, parcel_id TEXT,
      source_year INTEGER NOT NULL, price_per_m2 NUMERIC NOT NULL, source TEXT NOT NULL DEFAULT 'DVF',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(mutation_id,property_type,price,surface,address,parcel_id)
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

  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_commune_date ON jml_dvf_sales(commune_code,sale_date DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_geo_date ON jml_dvf_sales(latitude,longitude,sale_date DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_type_surface ON jml_dvf_sales(property_type,surface)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_updated ON jml_prospects(updated_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_status ON jml_prospects(status)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_next_action ON jml_prospects(next_action_at)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_activities_prospect ON jml_activities(prospect_id,created_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_leads_created ON jml_leads(created_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_prospect ON jml_seller_spaces(prospect_id)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_updated ON jml_seller_spaces(updated_at DESC)");
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
    const ss=await db("SELECT COUNT(*)::int AS count FROM jml_seller_spaces");
    const last=await db("SELECT id,name,created_at,updated_at FROM jml_prospects ORDER BY created_at DESC LIMIT 5");
    res.json({
      ok:true,
      version:VERSION,
      database:"postgres",
      prospects:q.rows[0].count,
      activities:a.rows[0].count,
      leads:l.rows[0].count,
      sellerSpaces:ss.rows[0].count,
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


app.get("/api/appointment-requests", async (_req,res) => {
  try{
    if(!pool) return res.json({ok:true,requests:[]});
    const q=await db("SELECT r.*, p.name AS prospect_name, p.status AS prospect_status FROM jml_appointment_requests r LEFT JOIN jml_prospects p ON p.id=r.prospect_id ORDER BY CASE WHEN r.status='À traiter' THEN 0 ELSE 1 END, r.created_at DESC");
    return res.json({ok:true,requests:q.rows});
  }catch(e){return unexpected(res,"JML-A011","Lecture des demandes de rendez-vous indisponible.",e);}
});

app.post("/api/appointment-requests/:id/confirm", async (req,res) => {
  const id=clean(req.params.id,100);
  try{
    if(!pool) return apiError(res,503,"JML-A012","PostgreSQL n'est pas configuré.");
    const q=await db("SELECT r.*, p.id AS pid, p.name AS pname, p.email AS pemail, p.phone AS pphone FROM jml_appointment_requests r LEFT JOIN jml_prospects p ON p.id=r.prospect_id WHERE r.id=$1",[id]);
    if(!q.rowCount) return apiError(res,404,"JML-A013","Demande de rendez-vous introuvable.");
    const r=q.rows[0];
    if(r.status!=="À traiter") return apiError(res,409,"JML-A014","Cette demande a déjà été traitée.");
    if(!r.pid) return apiError(res,409,"JML-A015","Cette demande n'est pas rattachée à un prospect.");
    const note=clean(req.body?.note,500);
    await db("INSERT INTO jml_activities (id,prospect_id,type,note,outcome,appointment_at,appointment_location,created_at) VALUES ($1,$2,'RDV',$3,'RDV pris',$4,$5,NOW())",[newId(),r.pid,"Rendez-vous confirmé depuis la demande vendeur."+(note?" "+note:""),r.requested_at,r.requested_location||null]);
    await db("UPDATE jml_prospects SET status='RDV pris',next_action='Préparer et confirmer le rendez-vous.',next_action_at=$2,updated_at=NOW() WHERE id=$1",[r.pid,r.requested_at]);
    await db("UPDATE jml_appointment_requests SET status='Confirmée' WHERE id=$1",[id]);
    let email={sent:false};
    try{email=await sendAppointmentConfirmationEmail({name:r.pname,email:r.pemail},note,r.requested_at,r.requested_location||"");}catch(e){console.warn("JML confirmation email demande RDV:",e);}
    return res.json({ok:true,status:"Confirmée",emailSent:!!email.sent});
  }catch(e){return unexpected(res,"JML-A016","Confirmation du rendez-vous indisponible.",e);}
});

app.post("/api/appointment-requests/:id/reject", async (req,res) => {
  try{
    if(!pool) return apiError(res,503,"JML-A017","PostgreSQL n'est pas configuré.");
    const q=await db("SELECT id,status FROM jml_appointment_requests WHERE id=$1",[req.params.id]);
    if(!q.rowCount) return apiError(res,404,"JML-A018","Demande de rendez-vous introuvable.");
    if(q.rows[0].status!=="À traiter") return apiError(res,409,"JML-A019","Cette demande a déjà été traitée.");
    await db("UPDATE jml_appointment_requests SET status='À revoir' WHERE id=$1",[req.params.id]);
    return res.json({ok:true,status:"À revoir"});
  }catch(e){return unexpected(res,"JML-A020","Traitement de la demande indisponible.",e);}
});

function buildAppointmentSlots(days=21){
  const slots=[]; const nowMs=Date.now(); const blocked=[];
  return {slots,blocked,nowMs,days};
}
async function getBookedAppointmentTimes(){
  if(!pool) return [];
  const q=await db("SELECT requested_at FROM jml_appointment_requests WHERE status='À traiter' UNION ALL SELECT appointment_at AS requested_at FROM jml_activities WHERE outcome='RDV pris' AND appointment_at IS NOT NULL");
  return q.rows.map(r=>new Date(r.requested_at).getTime()).filter(Number.isFinite);
}
function availableSlotList(booked=[]){
  const out=[], set=new Set(booked);
  const start=new Date(); start.setHours(0,0,0,0);
  for(let d=1;d<=21;d++){
    const day=new Date(start); day.setDate(start.getDate()+d);
    const dow=day.getDay();
    if(dow===0) continue;
    const endHour=dow===6?13:18;
    for(let h=9;h<endHour;h++){
      const dt=new Date(day); dt.setHours(h,0,0,0);
      if(dt.getTime()<=Date.now()) continue;
      if(!set.has(dt.getTime())) out.push(dt.toISOString());
    }
  }
  return out;
}

app.get("/api/appointment-slots", async (_req,res) => {
  try{
    const booked=await getBookedAppointmentTimes();
    const slots=availableSlotList(booked);
    return res.json({ok:true,slots,timezone:"Europe/Paris",rules:"Du lundi au vendredi de 9h à 18h, samedi de 9h à 13h. Les créneaux déjà demandés ou confirmés sont masqués."});
  }catch(e){return unexpected(res,"JML-A021","Lecture des créneaux disponibles indisponible.",e);}
});

app.post("/api/public-appointment", async (req,res) => {
  const b=req.body||{};
  const prospectId=clean(b.prospectId,100);
  const name=clean(b.name,120);
  const email=cleanEmail(b.email);
  const phone=clean(b.phone,40);
  const city=clean(b.city,100);
  const requestedAtRaw=clean(b.requestedAt,60);
  const requestedLocation=clean(b.requestedLocation,250);
  const message=clean(b.message,1000);
  if(!name) return apiError(res,400,"JML-A001","Nom requis.");
  if(!email&&!phone) return apiError(res,400,"JML-A002","Email ou téléphone requis.");
  if(!validEmail(email)) return apiError(res,400,"JML-A003","Email invalide.");
  if(!requestedAtRaw) return apiError(res,400,"JML-A004","Date et créneau souhaités requis.");
  const requestedAt=new Date(requestedAtRaw);
  if(Number.isNaN(requestedAt.getTime())) return apiError(res,400,"JML-A005","Date du rendez-vous invalide.");
  if(requestedAt.getTime()<Date.now()-5*60*1000) return apiError(res,400,"JML-A006","Le créneau demandé est déjà passé.");
  const requestedSlots=availableSlotList(await getBookedAppointmentTimes());
  if(!requestedSlots.includes(requestedAt.toISOString())) return apiError(res,409,"JML-A007","Ce créneau n’est plus disponible. Choisissez-en un autre.");
  try{
    if(pool){
      const exists=prospectId?await db("SELECT id FROM jml_prospects WHERE id=$1",[prospectId]):{rowCount:0};
      const id=newId();
      await db(
        "INSERT INTO jml_appointment_requests (id,prospect_id,name,email,phone,city,requested_at,requested_location,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'À traiter')",
        [id,exists.rowCount?prospectId:null,name,email||null,phone||null,city||null,requestedAt,requestedLocation||null,message||null]
      );
      if(exists.rowCount){
        await db(
          "INSERT INTO jml_activities (id,prospect_id,type,note,outcome,created_at) VALUES ($1,$2,'RDV',$3,'À rappeler',$4)",
          [newId(),prospectId,"Demande de rendez-vous vendeur · "+requestedAt.toLocaleString("fr-FR",{dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"})+(requestedLocation?" · "+requestedLocation:"")+(message?" · "+message:""),now()]
        );
        await db("UPDATE jml_prospects SET status='À relancer',next_action='Traiter la demande de rendez-vous vendeur.',next_action_at=NOW(),updated_at=NOW() WHERE id=$1",[prospectId]);
      }
      return res.status(201).json({ok:true,id,linkedToProspect:!!exists.rowCount,status:"À traiter"});
    }
    return res.status(503).json({ok:false,error:"Le stockage des demandes de rendez-vous n'est pas disponible."});
  }catch(e){return unexpected(res,"JML-A010","Enregistrement de la demande de rendez-vous indisponible.",e);}
});


function newSellerSpaceToken(){ return crypto.randomBytes(32).toString("hex"); }

async function createSellerSpace(data, prospectId){
  const space={
    id:newId(), accessToken:newSellerSpaceToken(), prospectId:prospectId||null,
    city:clean(data.city,100), address:clean(data.address,180), propertyType:clean(data.propertyType,60),
    horizon:clean(data.horizon,20), surface:clean(data.surface,40), rooms:clean(data.rooms,40),
    dpe:clean(data.dpe,10), terrain:clean(data.terrain,40), checklist:[], createdAt:now(), updatedAt:now()
  };
  if(pool){
    await db(
      `INSERT INTO jml_seller_spaces
       (id,access_token,prospect_id,city,address,property_type,horizon,surface,rooms,dpe,terrain,checklist,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [space.id,space.accessToken,space.prospectId,space.city||null,space.address||null,space.propertyType||null,space.horizon||null,space.surface||null,space.rooms||null,space.dpe||null,space.terrain||null,JSON.stringify(space.checklist),space.createdAt,space.updatedAt]
    );
  }else memory.sellerSpaces.set(space.accessToken,space);
  return space;
}

function sellerSpacePublic(row){
  if(!row) return null;
  return {
    id:row.id, accessToken:row.access_token||row.accessToken, prospectId:row.prospect_id||row.prospectId||null,
    city:row.city||"", address:row.address||"", propertyType:row.property_type||row.propertyType||"",
    horizon:row.horizon||"unknown", surface:row.surface||"", rooms:row.rooms||"", dpe:row.dpe||"", terrain:row.terrain||"",
    checklist:Array.isArray(row.checklist)?row.checklist:[], createdAt:row.created_at||row.createdAt, updatedAt:row.updated_at||row.updatedAt
  };
}

app.get("/api/seller-space/:token", async (req,res)=>{
  const token=clean(req.params.token,100);
  if(!token) return apiError(res,400,"JML-S001","Accès vendeur invalide.");
  try{
    if(pool){
      const q=await db("SELECT * FROM jml_seller_spaces WHERE access_token=$1 LIMIT 1",[token]);
      if(!q.rowCount) return apiError(res,404,"JML-S002","Espace vendeur introuvable.");
      return res.json({ok:true,space:sellerSpacePublic(q.rows[0])});
    }
    const space=memory.sellerSpaces.get(token);
    if(!space) return apiError(res,404,"JML-S002","Espace vendeur introuvable.");
    return res.json({ok:true,space:sellerSpacePublic(space)});
  }catch(e){return unexpected(res,"JML-S003","Lecture de votre espace vendeur indisponible.",e);}
});

app.patch("/api/seller-space/:token", async (req,res)=>{
  const token=clean(req.params.token,100), b=req.body||{};
  const fields={city:clean(b.city,100),address:clean(b.address,180),propertyType:clean(b.propertyType,60),horizon:clean(b.horizon,20),surface:clean(b.surface,40),rooms:clean(b.rooms,40),dpe:clean(b.dpe,10),terrain:clean(b.terrain,40)};
  const checklist=Array.isArray(b.checklist)?b.checklist.map(x=>Number(x)).filter(x=>Number.isInteger(x)&&x>=1&&x<=6).slice(0,6):null;
  try{
    if(pool){
      const q=await db(`UPDATE jml_seller_spaces SET city=$2,address=$3,property_type=$4,horizon=$5,surface=$6,rooms=$7,dpe=$8,terrain=$9,
        checklist=COALESCE($10::jsonb,checklist),updated_at=NOW() WHERE access_token=$1 RETURNING *`,
        [token,fields.city||null,fields.address||null,fields.propertyType||null,fields.horizon||"unknown",fields.surface||null,fields.rooms||null,fields.dpe||null,fields.terrain||null,checklist?JSON.stringify(checklist):null]);
      if(!q.rowCount) return apiError(res,404,"JML-S004","Espace vendeur introuvable.");
      return res.json({ok:true,space:sellerSpacePublic(q.rows[0])});
    }
    const space=memory.sellerSpaces.get(token);
    if(!space) return apiError(res,404,"JML-S004","Espace vendeur introuvable.");
    Object.assign(space,fields); if(checklist) space.checklist=checklist; space.updatedAt=now(); memory.sellerSpaces.set(token,space);
    return res.json({ok:true,space:sellerSpacePublic(space)});
  }catch(e){return unexpected(res,"JML-S005","Mise à jour de votre espace vendeur indisponible.",e);}
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

        const sellerSpace=await createSellerSpace({city:lead.city,address:b.address,propertyType:lead.propertyType,horizon:lead.horizon,surface:b.surface,rooms:b.rooms,dpe:b.dpe,terrain:b.terrain},prospectId);
        const sellerSpaceUrl=req.protocol+"://"+req.get("host")+"/espace-vendeur/"+sellerSpace.accessToken;
        let emailConfirmation = { sent: false, reason: "no-email" };
        try {
          emailConfirmation = await sendLeadConfirmationEmail(lead,sellerSpaceUrl);
        } catch (emailErr) {
          console.error("JML email confirmation failed:", emailErr);
          emailConfirmation = { sent: false, reason: "send-failed" };
        }
        return res.status(201).json({ok:true,persisted:true,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation,spaceToken:sellerSpace.accessToken,spaceUrl:sellerSpaceUrl});
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
    const sellerSpace=await createSellerSpace({city:lead.city,address:b.address,propertyType:lead.propertyType,horizon:lead.horizon,surface:b.surface,rooms:b.rooms,dpe:b.dpe,terrain:b.terrain},prospectId);
    const sellerSpaceUrl=req.protocol+"://"+req.get("host")+"/espace-vendeur/"+sellerSpace.accessToken;
    let emailConfirmation = { sent: false, reason: "no-email" };
    try {
      emailConfirmation = await sendLeadConfirmationEmail(lead,sellerSpaceUrl);
    } catch (emailErr) {
      console.error("JML email confirmation failed:", emailErr);
      emailConfirmation = { sent: false, reason: "send-failed" };
    }
    return res.status(201).json({ok:true,persisted:false,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation,spaceToken:sellerSpace.accessToken,spaceUrl:sellerSpaceUrl});
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

app.get("/api/seller-advice",function(req,res){
  const city=clean(req.query.city,100);
  const isArdennes=/ardennes|charleville|sedan|rethel|revin|nouzon|givet|fumay/i.test(city||"");
  const items=[
    {category:"🏦 CRÉDIT",title:"Les taux immobiliers restent autour de 3,4 % sur 20 ans",text:"CAFPI relève au 25 septembre 2026 un taux moyen de 3,43 % sur 20 ans et 3,53 % sur 25 ans. Pour un vendeur, le financement des acquéreurs reste un élément important à surveiller.",takeaway:"Le budget des acheteurs dépend aussi de leurs conditions de financement.",sourceName:"CAFPI — baromètre des taux, 25/09/2026",sourceUrl:"https://www.cafpi.fr/credit-immobilier/barometre-taux/actualites-taux/analyse-taux-credit-immobilier-septembre-2026",publishedAt:"25/09/2026"},
    {category:"⚡ DPE",title:"Le calcul du DPE évolue au 1er janvier 2027",text:"Le coefficient de conversion de l’électricité passera de 1,9 à 1,7. Certains logements chauffés à l’électricité pourront voir leur étiquette énergétique s’améliorer, mais ce n’est pas automatique.",takeaway:"Avant une vente, vérifiez la date et la situation exacte de votre DPE.",sourceName:"Service-Public.fr — information officielle, 01/09/2026",sourceUrl:"https://www.service-public.gouv.fr/particuliers/actualites/A18446",publishedAt:"01/09/2026"},
    {category:"📊 MARCHÉ",title:"Les Notaires publient les repères de prix des Ardennes",text:"Les données immobilières notariales permettent de comparer les niveaux de prix à l’échelle du département et des territoires.",takeaway:"Une médiane départementale ne remplace jamais une analyse du bien et de son secteur précis.",sourceName:"Notaires de France — immobilier",sourceUrl:"https://www.immobilier.notaires.fr/fr/prix-immobilier",publishedAt:"Consulté le 29/09/2026"},
    {category:"💡 CONSEIL",title:"Un prix de vente doit être comparé à des transactions réelles",text:"La base DVF permet de consulter les transactions immobilières intervenues en France au cours des cinq dernières années.",takeaway:"Avant de fixer un prix, croisez transactions, type de bien, surface, état et localisation.",sourceName:"Service-Public.fr — DVF",sourceUrl:"https://www.service-public.gouv.fr/particuliers/vosdroits/F16832",publishedAt:"Vérifié le 29/09/2026"}
  ];
  const filtered=isArdennes ? items : items.filter(function(x){return x.category!=="📊 MARCHÉ";});
  res.json({ok:true,city:city||null,updatedAt:"29/09/2026",items:filtered});
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
app.get("*",(_req,res)=>res.redirect(302,"/projet-vendeur"));

async function start(){
  // Render doit pouvoir valider le port/health check immédiatement.
  // L'initialisation PostgreSQL se fait ensuite sans bloquer le démarrage HTTP.
  app.listen(PORT,()=>console.log(`JML Projet Vendeur v${VERSION} HTTP listening on ${PORT}`));
  try{
    await initDb();
    console.log(`JML Projet Vendeur v${VERSION} database ready`);
  }catch(err){
    console.error("DB init failed:",err);
    console.error("JML Projet Vendeur continue en mode dégradé tant que PostgreSQL n'est pas disponible.");
  }
}
start();
