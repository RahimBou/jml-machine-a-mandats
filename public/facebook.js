window.jmlFacebook=function(){
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  const target=document.getElementById("view-facebook");
  if(!target)return;
  target.classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view==="facebook"));
  const title=document.getElementById("pageTitle");if(title)title.textContent="Facebook";
  const sub=document.getElementById("pageSubtitle");if(sub)sub.textContent="Transformer les demandes Facebook en prospects réellement traitables.";
  loadFacebookAcquisition();
};
async function loadFacebookAcquisition(){
 const box=document.getElementById("facebookLeadList"),status=document.getElementById("facebookStatus");
 if(!box||!status)return;
 status.textContent="Chargement…";
 try{
  const [lr,pr]=await Promise.all([
   fetch("/api/leads",{cache:"no-store"}).then(r=>r.json()),
   fetch("/api/prospects",{cache:"no-store"}).then(r=>r.json())
  ]);
  const leads=Array.isArray(lr.leads)?lr.leads:[];
  const prospects=Array.isArray(pr.prospects)?pr.prospects:[];
  const fb=leads.filter(x=>String(x.source||"").toLowerCase().startsWith("facebook"));
  const converted=fb.filter(l=>prospects.some(p=>(l.email&&p.email&&l.email.toLowerCase()===p.email.toLowerCase())||(l.phone&&p.phone&&l.phone===p.phone)));
  const rdv=converted.filter(l=>{const p=prospects.find(p=>(l.email&&p.email&&l.email.toLowerCase()===p.email.toLowerCase())||(l.phone&&p.phone&&l.phone===p.phone));return p&&p.status==="RDV pris"}).length;
  const mandats=converted.filter(l=>{const p=prospects.find(p=>(l.email&&p.email&&l.email.toLowerCase()===p.email.toLowerCase())||(l.phone&&p.phone&&l.phone===p.phone));return p&&p.status==="Mandat"}).length;
  document.getElementById("fbCount").textContent=fb.length;
  document.getElementById("fbConverted").textContent=converted.length;
  document.getElementById("fbRdv").textContent=rdv;
  document.getElementById("fbMandats").textContent=mandats;
  status.textContent=fb.length+" lead(s) Facebook récupéré(s).";
  box.innerHTML=fb.length?fb.slice(0,50).map(l=>{
    const p=prospects.find(p=>(l.email&&p.email&&l.email.toLowerCase()===p.email.toLowerCase())||(l.phone&&p.phone&&l.phone===p.phone));
    const already=!!p;
    return '<div class="idea"><div><strong>'+esc(l.name)+'</strong><span class="muted">'+esc(l.city||"")+" · "+esc(l.source||"Facebook")+" · "+new Date(l.created_at||l.createdAt).toLocaleDateString("fr-FR")+'</span></div><button class="secondary" data-fb-lead="'+esc(l.id)+'" '+(already?"disabled":"")+ '>'+ (already?"Dans le CRM":"Convertir en prospect")+'</button></div>';
  }).join(""):"Aucun lead Facebook pour le moment.";
  box.querySelectorAll("[data-fb-lead]").forEach(btn=>btn.addEventListener("click",()=>convertFacebookLead(btn.dataset.fbLead,leads,prospects)));
 }catch(e){status.textContent="Impossible de charger les leads Facebook : "+e.message}
}
async function convertFacebookLead(id,leads,prospects){
 const l=leads.find(x=>String(x.id)===String(id));if(!l)return;
 try{
  const body={name:l.name,city:l.city||"",phone:l.phone||"",email:l.email||"",property_type:l.property_type||l.propertyType||"Maison",horizon:l.horizon||"unknown",source:l.source||"Facebook",status:"À qualifier",contact_basis:"Contact demandé par la personne",contact_consent:true,notes:"Lead capté via Facebook. Demande explicite de recontact."};
  const r=await fetch("/api/prospects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();if(!r.ok)throw new Error(d.error||"Conversion impossible.");
  toast("Lead Facebook converti en prospect.");
  loadFacebookAcquisition();
 }catch(e){toast(e.message,true)}
}
document.addEventListener("DOMContentLoaded",function(){
 const b=document.querySelector('[data-view="facebook"]');
 if(b)b.addEventListener("click",function(e){e.preventDefault();window.jmlFacebook()});
});
