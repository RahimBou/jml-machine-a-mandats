const { Pool } = require("pg");
const { Readable } = require("stream");
const readline = require("readline");
const fs = require("fs");
const { spawn } = require("child_process");

const DATABASE_URL=String(process.env.DATABASE_URL||"").trim();
if(!DATABASE_URL) throw new Error("DATABASE_URL manquante");
const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},
  max:2,
  connectionTimeoutMillis:15000
});

const URL="https://www.insee.fr/fr/statistiques/fichier/8217525/BPE25.zip";
const ZIP_PATH="/tmp/BPE25.zip";
const EXPECTED_MEMBER="BPE25.csv";
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

    console.log("Téléchargement BPE 2025 INSEE (archive officielle)...");
    const response=await fetch(URL,{headers:{"User-Agent":"JML-Projet-Vendeur-BPE/1.0"},signal:AbortSignal.timeout(180000)});
    if(!response.ok) throw new Error("INSEE BPE HTTP "+response.status);
    const zipPath=ZIP_PATH;
    await new Promise(async(resolve,reject)=>{
      const file=fs.createWriteStream(zipPath);
      file.on("error",reject); file.on("finish",resolve);
      try{Readable.fromWeb(response.body).pipe(file);}catch(error){reject(error);}
    });

    const list=spawn("unzip",["-l",zipPath],{stdio:["ignore","pipe","pipe"]});
    let listOut="",listErr="";
    list.stdout.on("data",d=>{listOut+=String(d);});
    list.stderr.on("data",d=>{listErr+=String(d);});
    await new Promise((resolve,reject)=>list.on("close",code=>{
      if(code!==0)return reject(new Error("Lecture de l’archive BPE impossible: "+listErr));      if(!listOut.includes(EXPECTED_MEMBER)){
        return reject(new Error("Le fichier "+EXPECTED_MEMBER+" est absent de l’archive INSEE."));
      }
      resolve();
    }));
    console.log("Archive BPE validée : "+EXPECTED_MEMBER);
    const csvStream=spawn("unzip",["-p",zipPath,EXPECTED_MEMBER],{stdio:["ignore","pipe","pipe"]});
    let unzipErr="";
    csvStream.stderr.on("data",d=>{unzipErr+=String(d);});
    const input=csvStream.stdout;
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
    await new Promise((resolve,reject)=>csvStream.on("close",code=>code===0?resolve():reject(new Error("Extraction BPE25.csv impossible: "+unzipErr))));
    await client.query("COMMIT");
    try{fs.unlinkSync(zipPath);}catch(_){}
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
  const values=[]; const params=[];
  rows.forEach((r,rowIndex)=>{
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
