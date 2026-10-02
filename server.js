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
        roads:{label:"Grands axes routiers",count:0,items:[]},
        parks:{label:"Parcs, jeux & loisirs",count:0,items:[]},
        health:{label:"Santé",count:0,items:[]},
        services:{label:"Services du quotidien",count:0,items:[]}
      }
    };
    const add=(cat,name,dist,type)=>{const x=out.categories[cat];if(!x)return;x.count++;if(x.items.length<5)x.items.push({name:name||"Équipement sans nom",type:type||null,distanceKm:Number(dist.toFixed(2))});};
    const distance=(e)=>{const p=e?.center||e,x=Number(p?.lon??e?.lon),y=Number(p?.lat??e?.lat);const d=haversineKm({lat:la,lon:lo},{lat:y,lon:x});return d==null?999:d;};
    for(const e of elements){
      const t=e?.tags||{},d=distance(e),name=String(t.name||t.operator||"").trim();
      if(d>1.5 && !/^(motorway|trunk|primary|secondary)$/.test(String(t.highway||"")))continue;
      if(/^(motorway|trunk|primary|secondary)$/.test(String(t.highway||""))){
        const ref=String(t.ref||"").trim();
        const roadName=ref&&name?ref+" — "+name:(ref||name||"Grand axe routier");
        const roadType={motorway:"Autoroute",trunk:"Voie rapide",primary:"Route principale",secondary:"Axe départemental / secondaire"}[String(t.highway)]||"Grand axe routier";
        add("roads",roadName,d,roadType);
        continue;
      }
      if(["school","kindergarten","childcare","college","university"].includes(t.amenity))add("schools",name,d);
      else if(t.shop)add("commerces",name,d);
      else if(t.highway==="bus_stop"||["station","halt","tram_stop"].includes(t.railway)||t.amenity==="parking")add("transport",name,d);
      else if(["park","playground","sports_centre","pitch","garden"].includes(t.leisure)||t.tourism==="picnic_site")add("parks",name,d);
      else if(["pharmacy","doctors","clinic","hospital"].includes(t.amenity))add("health",name,d);
      else if(["post_office","bank","library","restaurant","cafe"].includes(t.amenity))add("services",name,d);
    }
    Object.values(out.categories).forEach(x=>x.items.sort((a,b)=>a.distanceKm-b.distanceKm));

    // Secours dédié pour les grands axes : indépendant des autres équipements.
    // Il permet d'afficher les axes même si la requête mixte OSM renvoie
    // correctement les services mais pas les ways routiers.
    if(!out.categories.roads.items.length){
      try{
        const roadQuery=`[out:json][timeout:8];
          way(around:5000,${la},${lo})[highway~"^(motorway|trunk|primary|secondary)$"];
          out center tags;`;
        for(const endpoint of endpoints){
          try{
            const rr=await fetch(endpoint,{
              method:"POST",
              headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.3.2 (roads-fallback)"},
              body:"data="+encodeURIComponent(roadQuery),
              signal:AbortSignal.timeout(8000)
            });
            if(!rr.ok) continue;
            const rp=await rr.json();
            for(const e of (Array.isArray(rp?.elements)?rp.elements:[])){
              const t=e?.tags||{}, d=distance(e);
              if(!Number.isFinite(d)||d>5) continue;
              const ref=String(t.ref||"").trim();
              const roadName=String(t.name||"").trim();
              const title=ref&&roadName?ref+" — "+roadName:(ref||roadName||"Grand axe routier");
              const roadType={motorway:"Autoroute",trunk:"Voie rapide",primary:"Route principale",secondary:"Axe départemental / secondaire"}[String(t.highway)]||"Grand axe routier";
              if(!out.categories.roads.items.some(x=>x.name===title)){
                out.categories.roads.items.push({name:title,type:roadType,distanceKm:Number(d.toFixed(2))});
              }
            }
            if(out.categories.roads.items.length) break;
          }catch(_){}
        }
        out.categories.roads.items.sort((a,b)=>a.distanceKm-b.distanceKm);
        out.categories.roads.items=out.categories.roads.items.slice(0,5);
        out.categories.roads.count=out.categories.roads.items.length;
      }catch(_){}
    }

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
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      const geo=await geocodeAddress(address,city);
      if(geo){lat=Number(geo.lat);lon=Number(geo.lon);}
      else{
        const commune=await resolveTerritoryCommune(city,address);
        const coords=commune?.centre?.coordinates;
        if(!Array.isArray(coords)||coords.length<2) return res.status(404).json({ok:false,available:false,error:"Localisation indisponible.",message:"La localisation du bien n'a pas pu être déterminée."});
        lon=Number(coords[0]);lat=Number(coords[1]);
      }