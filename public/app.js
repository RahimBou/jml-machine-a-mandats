window.__JML_APP_READY=false;
const state={prospects:[],leads:[],revision:0};
if(window.location.search){history.replaceState(null,"",window.location.pathname+window.location.hash);}
const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const views={dashboard:["Tableau de bord","Piloter l'acquisition, la qualification et le suivi des propriétaires."],prospects:["Prospects","Centraliser et suivre les propriétaires potentiellement vendeurs."],publication:["JML Publication","Préparer les contenus qui attirent les propriétaires locaux."],leadmagnet:["Lead Magnet","Capturer des demandes avec consentement explicite."],relances:["Relances","Préparer les prochaines actions sans envoi automatique."],kpi:["KPI","Mesurer le flux de prospects et les conversions."]};
function toast(message,error=false){const el=$("#toast");el.textContent=message;el.className="toast show"+(error?" error":"");clearTimeout(toast.t);toast.t=setTimeout(()=>el.className="toast",3500)}
async function api(url,options={}){const r=await fetch(url,{cache:"no-store",credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});let data={};try{data=await r.json()}catch{}if(!r.ok){const err=new Error(data.error||"Erreur serveur");err.status=r.status;err.code=data.code||"JML-HTTP";err.data=data;throw err}return data}
function showView(id){if(!views[id])return;$$(".view").forEach(v=>v.classList.remove("active"));$("#view-"+id).classList.add("active");$$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===id));$("#pageTitle").textContent=views[id][0];$("#pageSubtitle").textContent=views[id][1];if(id==="dashboard")renderDashboard();if(id==="prospects"){renderProspects();renderPipeline()}if(id==="relances")renderRelances();if(id==="leadmagnet")renderLeads();if(id==="publication")load();if(id==="kpi"){renderDashboard();renderKpi();}window.scrollTo({top:0,behavior:"smooth"})}
window.jmlShowView=showView;
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]))}
function horizon(h){return({"0-3":"0–3 mois","3-6":"3–6 mois","6-12":"6–12 mois","12+":"Plus de 12 mois",unknown:"À déterminer"})[h]||h}
function priorityClass(p){return p==="A"?"priority-a":p==="B"?"priority-b":"priority-c"}
function actionPriority(p){
  if(p.status==="Mandat"||p.status==="Pas de projet")return {level:"SUIVI",rank:4,reason:p.status==="Mandat"?"Mandat en cours":"Projet clos"};
  if(p.nextActionAt){
    const d=new Date(p.nextActionAt),now=new Date();
    if(!Number.isNaN(d.getTime())&&d<now)return {level:"URGENT",rank:0,reason:"Action en retard"};
    const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),tomorrow=new Date(today);
    tomorrow.setDate(tomorrow.getDate()+1);
    if(d<tomorrow)return {level:"AUJOURD'HUI",rank:1,reason:"Action prévue aujourd'hui"};
  }
  if(p.horizon==="0-3"&&(p.status==="À qualifier"||p.status==="À relancer"||!p.lastContactAt))return {level:"URGENT",rank:0,reason:"Projet à court terme"};
  if(p.horizon==="3-6")return {level:"À PRÉPARER",rank:2,reason:"Projet à préparer"};
  if(p.status==="À qualifier")return {level:"À QUALIFIER",rank:3,reason:"Qualification à terminer"};
  return {level:"SUIVI",rank:4,reason:"Suivi commercial"};
}
function renderDashboard(){
  const p=state.prospects;
  const hot=p.filter(x=>x.horizon==="0-3"||x.horizon==="3-6");
  const rdv=p.filter(x=>x.status==="RDV pris");
  const mandats=p.filter(x=>x.status==="Mandat");
  $("#statProspects").textContent=p.length;
  $("#statHot").textContent=hot.length;
  $("#statRdv").textContent=rdv.length;
  $("#statMandats").textContent=mandats.length;
  $("#kProspects").textContent=p.length;
  $("#kRdv").textContent=rdv.length;
  $("#kMandats").textContent=mandats.length;
  $("#kRate").textContent=p.length?Math.round(rdv.length/p.length*100)+"%":"0%";$("#kHot").textContent=hot.length;$("#kMandatRate").textContent=p.length?Math.round(mandats.length/p.length*100)+"%":"0%";
  const top=[...p].filter(x=>x.score!=null).sort((a,b)=>{
    const aa=actionPriority(a),bb=actionPriority(b);
    return aa.rank-bb.rank||(b.score||0)-(a.score||0);
  }).slice(0,5);
  $("#priorityList").innerHTML=top.length?top.map(x=>{
    const ap=actionPriority(x);
    return '<div class="idea"><div><strong>'+esc(x.name)+'</strong><span class="muted">'+esc(x.city)+' · '+horizon(x.horizon)+' · '+esc(ap.reason)+'</span></div><span class="badge '+priorityClass(x.priority)+'">'+esc(ap.level)+' · '+esc(x.priority)+' · '+x.score+'/100</span></div>';
  }).join(""):"Aucun prospect analysé pour le moment.";
  const now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
  const urgent=p.filter(x=>x.status!=="Mandat"&&x.status!=="Pas de projet"&&x.nextActionAt&&new Date(x.nextActionAt)<tomorrow).sort((a,b)=>new Date(a.nextActionAt)-new Date(b.nextActionAt)).slice(0,5);
  const work=[...p].filter(x=>x.status!=="Mandat"&&x.status!=="Pas de projet").sort((a,b)=>{
    const aa=actionPriority(a),bb=actionPriority(b);
    return aa.rank-bb.rank||(b.score||0)-(a.score||0);
  }).slice(0,5);
  const workBox=$("#dailyWorkList");
  if(workBox)workBox.innerHTML=work.length?work.map(x=>{
    const ap=actionPriority(x);
    return '<div class="idea"><div><strong>'+esc(x.name)+'</strong><span class="muted">'+esc(ap.level)+' · '+esc(ap.reason)+' · '+horizon(x.horizon)+'</span></div><button class="secondary" data-action="details" data-id="'+esc(x.id)+'">Traiter</button></div>';
  }).join(""):"Aucun prospect à traiter.";
  const box=$("#dashboardRelances");
  if(box)box.innerHTML=urgent.length?urgent.map(x=>'<div class="idea"><div><strong>'+esc(x.name)+'</strong><span class="muted">'+(new Date(x.nextActionAt)<today?"🔴 En retard":"🟠 Aujourd'hui")+' · '+new Date(x.nextActionAt).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})+'</span></div><button class="secondary" data-action="details" data-id="'+esc(x.id)+'">Ouvrir</button></div>').join(""):"Aucune relance urgente.";
}
function renderKpi(){
  const p=state.prospects;
  const statuses=["À qualifier","Contacté","À relancer","RDV pris","Estimation","Mandat","Pas de projet"];
  const counts=Object.fromEntries(statuses.map(s=>[s,0]));
  p.forEach(x=>{if(counts[x.status]!=null)counts[x.status]++});
  const pipeline=$("#kpiPipeline");
  if(pipeline)pipeline.innerHTML=statuses.map(s=>'<div class="idea"><span>'+esc(s)+'</span><strong>'+counts[s]+'</strong></div>').join("");
  const withContact=p.filter(x=>x.phone||x.email).length;
  const qualified=p.filter(x=>x.score!=null).length;
  const withNext=p.filter(x=>x.nextActionAt).length;
  const quality=$("#kpiQuality");
  if(quality)quality.innerHTML='<div class="idea"><span>Coordonnées renseignées</span><strong>'+withContact+' / '+p.length+'</strong></div><div class="idea"><span>Prospects qualifiés</span><strong>'+qualified+' / '+p.length+'</strong></div><div class="idea"><span>Prochaine action programmée</span><strong>'+withNext+' / '+p.length+'</strong></div>';
}
function renderProspects(){const body=$("#prospectTable");body.innerHTML=state.prospects.length?state.prospects.map(p=>{const ap=actionPriority(p);return '<tr><td><strong>'+esc(p.name)+'</strong><br><span class="muted">'+esc(p.phone||p.email)+'</span></td><td>'+esc(p.city)+'</td><td>'+horizon(p.horizon)+'</td><td>'+esc(p.source)+'</td><td><span class="badge">'+esc(p.status)+'</span></td><td>'+(p.score!=null?'<span class="badge '+priorityClass(p.priority)+'">'+esc(ap.level)+' · '+esc(p.priority)+' · '+p.score+'</span>':"—")+'</td><td><button class="secondary" data-action="qualify" data-id="'+esc(p.id)+'">'+(p.score!=null?"Ré-analyser":"Analyser")+'</button> '+(p.score!=null?'<button class="secondary" data-action="details" data-id="'+esc(p.id)+'">Détails</button> ':'')+'<button class="secondary" data-action="delete" data-id="'+esc(p.id)+'">Suppr.</button></td></tr>'}).join(""):"<tr><td colspan='7' class='muted'>Aucun prospect.</td></tr>";$("#storageStatus").textContent="Données serveur · PostgreSQL si DATABASE_URL est active."}
function localDateTime(v){if(!v)return "";const d=new Date(v);const z=n=>String(n).padStart(2,"0");return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+"T"+z(d.getHours())+":"+z(d.getMinutes())}
function openDetails(id){
  const p=state.prospects.find(x=>x.id===id);if(!p)return;
  $("#detailTitle").textContent=p.name;
  const contact=p.phone||p.email||"Aucun contact renseigné";
  const next=p.nextAction||"Aucune prochaine action programmée";
  const ap=actionPriority(p);
  $("#detailBody").innerHTML='<div class="notice"><strong>À faire maintenant</strong><br><b>'+esc(ap.level)+'</b> · '+esc(ap.reason)+'<br>'+esc(next)+(p.nextActionAt?' · '+new Date(p.nextActionAt).toLocaleString("fr-FR"):'')+'</div>'+
  '<div class="form-actions" style="margin-top:12px;flex-wrap:wrap">'+
  '<button class="secondary" type="button" data-action="set-status" data-status="Contacté" data-id="'+esc(id)+'">Contacté</button>'+
  '<button class="secondary" type="button" data-action="set-status" data-status="À relancer" data-id="'+esc(id)+'">À relancer</button>'+
  '<button class="secondary" type="button" data-action="set-status" data-status="RDV pris" data-id="'+esc(id)+'">RDV pris</button>'+
  '</div>'+
  '<div class="detail-grid"><div class="detail-item"><span>Statut</span><strong>'+esc(p.status)+'</strong></div><div class="detail-item"><span>Priorité commerciale</span><strong>'+esc(ap.level)+'</strong></div><div class="detail-item"><span>Priorité qualification</span><strong class="badge '+priorityClass(p.priority)+'">'+esc(p.priority||"—")+' '+(p.score!=null?"· "+p.score+"/100":"")+'</strong></div><div class="detail-item"><span>Projet</span><strong>'+horizon(p.horizon)+'</strong></div><div class="detail-item"><span>Type de bien</span><strong>'+esc(p.propertyType||"—")+'</strong></div><div class="detail-item"><span>Contact</span><strong>'+esc(contact)+'</strong></div><div class="detail-item"><span>Source</span><strong>'+esc(p.source||"—")+'</strong></div><div class="detail-item"><span>Base de contact</span><strong>'+esc(p.contactBasis||"À vérifier")+'</strong></div><div class="detail-item"><span>Autorisation</span><strong>'+(p.contactConsent?"Obtenue":"Non obtenue")+'</strong></div><div class="detail-item"><span>Dernier contact</span><strong>'+(p.lastContactAt?new Date(p.lastContactAt).toLocaleString("fr-FR"):"Aucun")+'</strong></div><div class="detail-item"><span>Contacts</span><strong>'+esc(p.contactCount||0)+'</strong></div></div>'+
  '<div class="next-action"><strong>Programmer la prochaine action</strong><div class="form" style="margin-top:10px"><input id="followAction" value="'+esc(p.nextAction||"Relancer le prospect")+'" placeholder="Ex. Appeler pour proposer un RDV"><input id="followDate" type="datetime-local" value="'+localDateTime(p.nextActionAt)+'"><button class="primary" type="button" data-action="save-followup" data-id="'+esc(id)+'">Programmer la relance</button></div></div>'+
  '<div class="next-action"><strong>Enregistrer une action</strong><div class="form" style="margin-top:10px"><select id="activityType"><option>Appel</option><option>SMS</option><option>Email</option><option>RDV</option><option>Visite</option><option>Note</option></select><input id="activityNote" placeholder="Compte rendu / prochaine information"><button class="primary" type="button" data-action="save-activity" data-id="'+esc(id)+'">Enregistrer l\'action</button></div></div>'+
  '<h3>Pourquoi ce score ?</h3><ul class="detail-reasons">'+((p.reasons||[]).map(x=>"<li>"+esc(x)+"</li>").join("")||"<li>Aucun détail enregistré.</li>")+'</ul>'+
  '<h3>Historique</h3><div id="activityList"><span class="muted">Chargement…</span></div>';
  $("#detailModal").hidden=false;
  loadActivities(id);
}
async function loadActivities(id){
  try{const d=await api("/api/prospects/"+encodeURIComponent(id)+"/activities");const list=d.activities||[];$("#activityList").innerHTML=list.length?list.map(a=>'<div class="idea"><div><strong>'+esc(a.type)+'</strong><span class="muted">'+new Date(a.created_at).toLocaleString("fr-FR")+'</span></div><span>'+esc(a.note||"")+'</span></div>').join(""):"<span class='muted'>Aucune action enregistrée.</span>"}catch(e){$("#activityList").textContent=e.message}
}
async function renderPipeline(){try{const d=await api("/api/pipeline");const counts=d.pipeline||{};const statuses=["À qualifier","Contacté","À relancer","RDV pris","Estimation","Mandat","Pas de projet"];$("#pipelineBoard").innerHTML=statuses.map(st=>{const people=state.prospects.filter(p=>p.status===st);return '<div class="pipeline-col"><h3>'+esc(st)+'</h3><div class="pipeline-count">'+(counts[st]||0)+'</div><div class="pipeline-list">'+people.map(p=>'<div class="pipeline-person"><strong>'+esc(p.name)+'</strong><span class="muted">'+esc(p.city||"")+'</span><select data-pipeline-id="'+esc(p.id)+'"><option value="'+esc(st)+'">'+esc(st)+'</option>'+statuses.filter(x=>x!==st).map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("")+'</select></div>').join("")+'</div></div>'}).join("")}catch(e){$("#pipelineBoard").innerHTML='<div class="notice">'+esc(e.message)+'</div>'}}
function renderRelances(){
  const now=new Date();
  const startToday=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const endToday=new Date(startToday);endToday.setDate(endToday.getDate()+1);
  const list=state.prospects.filter(p=>p.status!=="Mandat"&&p.status!=="Pas de projet"&&(p.nextActionAt||p.horizon==="0-3"||p.horizon==="3-6"||p.status==="À relancer"||p.status==="À qualifier"));
  const late=[],today=[],upcoming=[],unplanned=[];
  list.forEach(p=>{
    if(!p.nextActionAt){unplanned.push(p);return}
    const d=new Date(p.nextActionAt);
    if(d<startToday)late.push(p);
    else if(d<endToday)today.push(p);
    else upcoming.push(p);
  });
  const sort=(a,b)=>{
    const ad=a.nextActionAt?new Date(a.nextActionAt).getTime():Infinity;
    const bd=b.nextActionAt?new Date(b.nextActionAt).getTime():Infinity;
    return ad-bd||(b.score||0)-(a.score||0);
  };
  [late,today,upcoming,unplanned].forEach(x=>x.sort(sort));
  const item=p=>{const ap=actionPriority(p);return '<div class="idea"><div><strong>'+esc(p.name)+'</strong><span class="muted">'+esc(p.city)+' · '+horizon(p.horizon)+(p.score!=null?' · '+esc(ap.level)+' · Priorité '+esc(p.priority):'')+(p.nextActionAt?' · '+new Date(p.nextActionAt).toLocaleString("fr-FR"):'')+'</span></div><button class="secondary" data-action="relance" data-id="'+esc(p.id)+'">Préparer</button></div>'};
  const empty="<div class='notice'>Aucune relance dans cette catégorie.</div>";
  const set=(id,items)=>{const el=$("#"+id);if(el)el.innerHTML=items.length?items.map(item).join(""):empty};
  set("relanceLate",late);set("relanceToday",today);set("relanceUpcoming",upcoming);set("relanceUnplanned",unplanned);
}
function renderLeads(){const l=state.leads;$("#leadStatus").textContent=l.length?l.length+" lead(s) enregistré(s) côté serveur.":"Aucun lead capté pour le moment.";$("#leadList").innerHTML=l.map(x=>'<div class="idea"><div><strong>'+esc(x.name)+'</strong><span class="muted">'+esc(x.city||"")+' · '+esc(x.email||x.phone||"")+' · '+esc(x.horizon||"")+'</span></div><span class="badge">Lead Magnet</span></div>').join("")}
async function loadProspects(){const p=await api("/api/prospects");const incoming=Array.isArray(p.prospects)?p.prospects:[];state.prospects=incoming;renderDashboard();renderProspects();const status=$("#storageStatus");if(status)status.textContent=(p.persisted?"PostgreSQL":"Mémoire locale")+" · "+state.prospects.length+" prospect(s)";if($("#pipelineBoard"))renderPipeline();return incoming.length} 
async function load(){const errors=[];try{await loadProspects();window.__JML_APP_READY=true}catch(e){errors.push("prospects ["+(e.code||"JML-HTTP")+"]: "+e.message)}try{const l=await api("/api/leads");state.leads=l.leads||[];renderLeads()}catch(e){errors.push("leads ["+(e.code||"JML-HTTP")+"]: "+e.message)}try{const i=await api("/api/publication-ideas");$("#ideas").innerHTML=(i||[]).map(x=>'<div class="idea"><div><span class="muted">'+esc(x.target)+'</span><strong>'+esc(x.title)+'</strong><span class="muted">'+esc(x.hook)+'</span></div><button class="secondary" data-action="copy" data-text="'+esc(x.hook)+'">Copier</button></div>').join("")}catch(e){errors.push("publication ["+(e.code||"JML-HTTP")+"]: "+e.message)}if(errors.length)toast("Certaines données n’ont pas pu être chargées : "+errors.join(" · "),true)}
window.jmlAction=async function(a,id,b){
  try{
    if(a==="delete"){if(!confirm("Supprimer ce prospect ?"))return;await api("/api/prospects/"+encodeURIComponent(id),{method:"DELETE"});toast("Prospect supprimé.");await load();return}
    if(a==="qualify"){const q=await api("/api/prospects/"+encodeURIComponent(id)+"/qualify",{method:"POST"});toast("Priorité "+q.priority+" · "+q.score+"/100");await load();return}
    if(a==="details"){openDetails(id);return}
    if(a==="set-status"){const status=b?.dataset?.status;await api("/api/prospects/"+encodeURIComponent(id)+"/status",{method:"PUT",body:JSON.stringify({status})});toast("Statut mis à jour : "+status);await load();openDetails(id);return}
    if(a==="save-activity"){const type=$("#activityType").value,note=$("#activityNote").value;await api("/api/prospects/"+encodeURIComponent(id)+"/activity",{method:"POST",body:JSON.stringify({type,note})});toast("Action enregistrée.");await load();openDetails(id);return}
    if(a==="save-followup"){const nextAction=$("#followAction").value.trim(),nextActionAt=$("#followDate").value;await api("/api/prospects/"+encodeURIComponent(id)+"/follow-up",{method:"PUT",body:JSON.stringify({nextAction,nextActionAt})});toast("Prochaine relance programmée.");await load();openDetails(id);return}
    if(a==="relance"){openDetails(id);return}
    if(a==="copy"){const value=b?.dataset?.text||"";if(navigator.clipboard)await navigator.clipboard.writeText(value);toast("Copié.");return}
  }catch(err){toast((err.code?err.code+" — ":"")+err.message,true)}
};
document.addEventListener("change",async e=>{const s=e.target.closest("[data-pipeline-id]");if(!s)return;try{await api("/api/prospects/"+encodeURIComponent(s.dataset.pipelineId)+"/status",{method:"PUT",body:JSON.stringify({status:s.value})});toast("Étape du pipeline mise à jour.");await load();renderPipeline()}catch(err){toast(err.message,true)}});
document.addEventListener("click",e=>{
  const view=e.target.closest("[data-view]");
  if(view){e.preventDefault();window.jmlNav(view.dataset.view);return}
  const b=e.target.closest("button[data-action]");
  if(b){e.preventDefault();window.jmlAction(b.dataset.action,b.dataset.id,b)}
});
$("#newProspectBtn").addEventListener("click",()=>{showView("prospects");setTimeout(()=>$("#pName").focus(),50)});
$("#cancelProspect").addEventListener("click",()=>showView("dashboard"));
$("#prospectForm").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());try{const created=await api("/api/prospects",{method:"POST",body:JSON.stringify(data)});if(created.prospect){state.revision++;state.prospects=[created.prospect,...state.prospects.filter(x=>x.id!==created.prospect.id)];renderDashboard();renderProspects();if($("#pipelineBoard"))renderPipeline()}form.reset();toast(data.contact_basis==="À vérifier"?"Prospect enregistré. Base de contact à préciser avant toute relance.":(created.persisted?"Prospect enregistré dans PostgreSQL.":"Prospect enregistré en mémoire."));showView("prospects");renderDashboard();renderProspects();if($("#pipelineBoard"))renderPipeline()}catch(err){toast(err.message,true)}});
window.addEventListener("DOMContentLoaded",()=>load());
$("#closeDetail").addEventListener("click",()=>$("#detailModal").hidden=true);$("#detailModal").addEventListener("click",e=>{if(e.target.id==="detailModal")e.currentTarget.hidden=true});document.addEventListener("keydown",e=>{if(e.key==="Escape")$("#detailModal").hidden=true});
