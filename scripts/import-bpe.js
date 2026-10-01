const { Pool } = require("pg");
const readline = require("readline");
const fs = require("fs");

const DATABASE_URL=String(process.env.DATABASE_URL||"").trim();
if(!DATABASE_URL) throw new Error("DATABASE_URL manquante");
const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},
  max:2,
  connectionTimeoutMillis:15000
});

const path=require("path");
const CSV_PATH=process.env.BPE_CSV_PATH||[path.join(process.cwd(),"data","BPE25_Ardennes.csv"),path.join(process.cwd(),"BPE25_Ardennes.csv")].find(fs.existsSync);
const YEAR=2025;
const DEP="08";
const BATCH=500;

function parseCsv(line){
  const out=[]; let v=""; let q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q&&line[i+1]==='"'){v+='"';i++;}
      else q=!q;
    }else if(ch===";"&&!q){out.push(v);v="";}
    else v+=ch;
  }
  out.push(v);
  return out;
}
const pick=(row,idx,...names)=>{
  for(const name of names){
    const i=idx[name.toLowerCase()];
    if(i!==undefined) return String(row[i]??"").trim();
  }
  return "";
};
const num=v=>{
  const n=Number(String(v||"").replace(",",".").trim());
  return Number.isFinite(n)?n:null;
};

async function main(){
  const client=await pool.connect();
  let deleted=0,inserted=0;
  try{
    await client.query(`CREATE TABLE IF NOT EXISTS jml_bpe_assets (
      id BIGSERIAL PRIMARY KEY,
      year INTEGER NOT NULL,
      commune_code TEXT NOT NULL,
      domain TEXT,
      subdomain TEXT,
      type_code TEXT,
      type_label TEXT,
      name TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      address TEXT,
      source TEXT NOT NULL DEFAULT 'INSEE BPE 2025',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(year,commune_code,type_code,name,latitude,longitude)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_bpe_commune ON jml_bpe_assets(commune_code)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_bpe_geo ON jml_bpe_assets(latitude,longitude)");

    if(!CSV_PATH) throw new Error("Fichier BPE local introuvable : data/BPE25_Ardennes.csv ou BPE25_Ardennes.csv");
    const sizeMb=(fs.statSync(CSV_PATH).size/1024/1024).toFixed(1);
    console.log("Import BPE local Ardennes : "+CSV_PATH+" ("+sizeMb+" Mo)");
    const input=fs.createReadStream(CSV_PATH);
    input.on("error",()=>{});
    await client.query("BEGIN");
    console.log("Filtrage BPE : département "+DEP+" ; domaines A-G ; coordonnées obligatoires.");
    const del=await client.query("DELETE FROM jml_bpe_assets WHERE year=$1 AND commune_code LIKE $2",[YEAR,DEP+"%"]);
    deleted=del.rowCount||0;

    const rl=readline.createInterface({input,crlfDelay:Infinity});
    let header=null,idx={};
    let batch=[];
    let scanned=0,validArdennes=0,skippedNoCoords=0;
    for await(const line of rl){
      if(!line) continue;
      if(!header){
        header=parseCsv(line).map(x=>x.replace(/^\uFEFF/,"").trim().toLowerCase());
        header.forEach((x,i)=>idx[x]=i);
        console.log("Colonnes BPE détectées:",header.length);
        continue;
      }
      const row=parseCsv(line);
      scanned++;
      const commune=pick(row,idx,"depcom");
      if(!/^08\d{3}$/.test(commune)) continue;
      const lat=num(pick(row,idx,"latitude"));
      const lon=num(pick(row,idx,"longitude"));
      if(lat===null||lon===null){skippedNoCoords++;continue;}
      validArdennes++;
      const domain=pick(row,idx,"dom");
      if(!/^[A-G]$/.test(domain)) continue;
      const subdomain=pick(row,idx,"sdom");
      const typeCode=pick(row,idx,"typequ","typequ_1");
      const typeLabel=pick(row,idx,"libelle_typequ","lib_equ","libelle_type_qu","type");
      const name=pick(row,idx,"nomrs")||typeLabel||"Équipement";
      const numvoie=pick(row,idx,"numvoie");
      const typvoie=pick(row,idx,"typvoie");
      const libvoie=pick(row,idx,"libvoie");
      const address=[numvoie,typvoie,libvoie].filter(Boolean).join(" ");
      batch.push([YEAR,commune,domain,subdomain,typeCode,typeLabel,name,lat,lon,address]);
      if(batch.length>=BATCH){
        await insertBatch(client,batch);
        inserted+=batch.length;
        batch=[];
        if(inserted%5000===0) console.log("BPE Ardennes importés:",inserted);
      }
    }
    if(batch.length){await insertBatch(client,batch);inserted+=batch.length;}
    await client.query("COMMIT");
    console.log(`BPE terminé : supprimés=${deleted}, insérés=${inserted}, lignes_scannées=${scanned}, Ardennes_avec_coordonnées=${validArdennes}, sans_coordonnées=${skippedNoCoords}`);
    if(inserted===0) throw new Error("Aucun équipement BPE Ardennes n’a été importé : vérifier le format DEPCOM et les coordonnées.");
  }catch(error){
    try{await client.query("ROLLBACK");}catch(_){}
    throw error;
  }finally{
    client.release();
    await pool.end();
  }
}

async function insertBatch(client,rows){
  if(!rows.length)return;
  // PostgreSQL refuse ON CONFLICT DO UPDATE lorsque deux lignes
  // du même INSERT portent exactement la même clé unique (SQLSTATE 21000).
  // Le fichier BPE peut contenir ce type de doublon : on déduplique donc
  // chaque lot avant de construire la requête SQL.
  const uniqueRows=[];
  const seen=new Set();
  for(const r of rows){
    const key=[r[0],r[1],r[4],r[6],r[7],r[8]].map(v=>String(v??"")).join("\x1f");
    if(seen.has(key)) continue;
    seen.add(key);
    uniqueRows.push(r);
  }
  if(!uniqueRows.length)return;

  const values=[]; const params=[];
  uniqueRows.forEach((r,rowIndex)=>{
    const base=rowIndex*10;
    values.push(`(${Array.from({length:10},(_,i)=>"$"+(base+i+1)).join(",")})`);
    params.push(...r);
  });
  await client.query(
    `INSERT INTO jml_bpe_assets
      (year,commune_code,domain,subdomain,type_code,type_label,name,latitude,longitude,address)
     VALUES ${values.join(",")}
     ON CONFLICT(year,commune_code,type_code,name,latitude,longitude) DO UPDATE SET
       domain=EXCLUDED.domain,subdomain=EXCLUDED.subdomain,type_label=EXCLUDED.type_label,address=EXCLUDED.address,imported_at=NOW()`,
    params
  );
}

main().catch(error=>{console.error("BPE import failed:",error);process.exitCode=1;});
