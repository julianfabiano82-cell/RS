"use strict";
/* RS · Mis turnos — frontend (habla con /api/*, sin localStorage para turnos ni credenciales) */

/* ================= Ajustes locales (solo defaults, no son datos de turnos) ================= */
const LS_SETTINGS = "rsd_settings_v2";
const DEFAULTS = { gasPrice: 4.60, maintenance: 0.10 };
const MPG = 22, COMMISSION = 0.75, IRS = 0.76; // fijos: los usa el servidor en la fórmula

function loadSettings(){
  try{ const raw=localStorage.getItem(LS_SETTINGS); if(raw) return Object.assign({},DEFAULTS,JSON.parse(raw)); }catch(e){}
  return Object.assign({},DEFAULTS);
}
function saveSettings(s){ localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }
let settings = loadSettings();
let shifts = [];
let me = null;
let editingId = null;
let sortDesc = true;

/* ================= Utilidades ================= */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtUSD(n){ const v=Number(n); return (v<0?"−$":"$")+Math.abs(v).toFixed(2); }
function fmtNum(n,d){ return Number(n).toFixed(d==null?2:d); }
function parseHM(t){ const p=String(t).split(":"); return Number(p[0])*60+Number(p[1]); }
function platLabel(p){ return p==="uber"?"Uber":p==="lyft"?"Lyft":"Ambas"; }
function fmtFecha(iso){ const p=String(iso).split("-"); return p.length===3?p[2]+"/"+p[1]+"/"+p[0].slice(2):iso; }
function todayISO(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

/* ============ Cálculo en cliente (idéntico al del servidor, para vista previa) ============
   neto = (bruto × 0.75) − ((millasPax + millasMuertas) × costoPorMilla) + (bono ÷ horas)
   costoPorMilla = (precioGasolina ÷ 22) + mantenimiento
   IRS 0.76/milla: solo referencia, no resta del neto. */
function computeShift(s){
  const horas=(parseHM(s.fin)-parseHM(s.inicio))/60;
  const millasTot=s.millas_pax+s.millas_muertas;
  const cpm=s.gas_price/MPG+s.maintenance;
  const neto=(s.bruto*COMMISSION)-(millasTot*cpm)+(horas>0?s.bono/horas:0);
  return { horas:horas, millasTot:millasTot, costoPorMilla:cpm, neto:neto,
    netoHora:horas>0?neto/horas:0, porMilla:millasTot>0?neto/millasTot:0, irsRef:millasTot*IRS };
}

/* ================= API ================= */
async function api(path, opts){
  opts = opts||{};
  const r = await fetch("/api"+path, Object.assign({credentials:"include",
    headers:{"Content-Type":"application/json"}}, opts));
  if(r.status===401){ showLogin(); throw new Error("no autenticado"); }
  let data=null; try{ data=await r.json(); }catch(e){}
  if(!r.ok) throw new Error((data&&data.error)||("error "+r.status));
  return data;
}

/* ================= Auth ================= */
function showLogin(){
  me=null; shifts=[];
  $("login-wrap").style.display="block"; $("app").style.display="none";
}
function showApp(){
  $("login-wrap").style.display="none"; $("app").style.display="block";
  $("whoami").textContent = me.username+" ("+me.role+")";
  if(me.role==="admin") loadAdminUsers();
}
async function checkAuth(){
  try{
    me = await api("/me");
    showApp(); await refreshAll(); goto("resumen");
  }catch(e){ showLogin(); }
}
$("login-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const box=$("login-errors"); box.classList.remove("show");
  try{
    me = await api("/login",{method:"POST",
      body:JSON.stringify({username:$("l-user").value.trim(), password:$("l-pass").value})});
    $("l-pass").value="";
    showApp(); await refreshAll(); goto("resumen");
  }catch(err){ box.textContent="⚠️ "+err.message; box.classList.add("show"); }
});
$("btn-logout").addEventListener("click", async ()=>{
  try{ await api("/logout",{method:"POST"}); }catch(e){}
  showLogin();
});
async function refreshAll(){
  shifts = await api("/shifts");
  renderResumen(); // renderResumen pide /api/summary internamente
}

/* ================= Navegación ================= */
function goto(view){
  document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  document.querySelectorAll("section.view").forEach(s=>s.classList.toggle("active",s.id==="view-"+view));
  if(view==="resumen") renderResumen();
  if(view==="historial") renderHistorial();
  if(view==="graficos") renderGraficos();
  window.scrollTo({top:0,behavior:"smooth"});
}
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>goto(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>goto(b.dataset.goto)));

/* ================= RESUMEN (números calculados en el servidor) ================= */
async function renderResumen(){
  if(!me) return;
  let sum;
  try{ sum = await api("/summary"); }
  catch(e){ return; }
  const has = shifts.length>0;
  $("resumen-empty").style.display = has?"none":"block";
  $("resumen-content").style.display = has?"block":"none";
  if(!has) return;
  $("k-bruto").textContent = fmtUSD(sum.total_bruto);
  const kN=$("k-neto"); kN.textContent=fmtUSD(sum.total_neto); kN.className="num "+(sum.total_neto>=0?"good":"bad");
  $("k-horas").textContent = fmtNum(sum.total_horas)+" h";
  const kNH=$("k-netoh"); kNH.textContent=fmtUSD(sum.neto_hora_prom)+"/h"; kNH.className="num "+(sum.neto_hora_prom>=0?"good":"bad");
  if(sum.mejor_turno){
    $("k-mejor").textContent=fmtUSD(sum.mejor_turno.neto_hora)+"/h";
    $("k-mejor").className="num "+(sum.mejor_turno.neto_hora>=0?"good":"bad");
    $("k-mejor").style.fontSize="1.15rem";
    $("k-mejor-sub").textContent=fmtFecha(sum.mejor_turno.fecha)+" · "+platLabel(sum.mejor_turno.plataforma);
  } else { $("k-mejor").textContent="—"; $("k-mejor-sub").textContent=""; }
  const d7=sum.ultimos_7_dias;
  const k7=$("k-7d"); k7.textContent=fmtUSD(d7.neto); k7.className="num "+(d7.neto>=0?"good":"bad");
  $("k-7d-sub").textContent=d7.turnos+" turnos · "+fmtNum(d7.horas)+" h";
  let html='<div class="kpis">';
  ["uber","lyft"].forEach(p=>{
    const g=sum.por_plataforma[p], v=g.neto_hora;
    html+='<div class="kpi"><div class="lbl"><span class="badge '+p+'">'+platLabel(p)+'</span></div>'
      +'<div class="num '+(v==null?"":v>=0?"good":"bad")+'">'+(v==null?"—":fmtUSD(v)+"/h")+'</div>'
      +'<div class="sub">'+(v==null?"sin turnos":g.turnos+" turnos · "+fmtNum(g.horas)+" h")+'</div></div>';
  });
  const ga=sum.por_plataforma.ambas;
  html+='<div class="kpi"><div class="lbl"><span class="badge ambas">Ambas</span></div>'
    +'<div class="num '+(ga.neto_hora==null?"":ga.neto_hora>=0?"good":"bad")+'">'+(ga.neto_hora==null?"—":fmtUSD(ga.neto_hora)+"/h")+'</div>'
    +'<div class="sub">'+(ga.neto_hora==null?"sin turnos":ga.turnos+" turnos · "+fmtNum(ga.horas)+" h")+'</div></div>';
  html+="</div>";
  const u=sum.por_plataforma.uber, l=sum.por_plataforma.lyft;
  if(u.neto_hora!=null && l.neto_hora!=null){
    const dif=u.neto_hora-l.neto_hora;
    html+='<p class="muted" style="margin:10px 0 0">'+(dif===0?"Uber y Lyft rinden igual por hora.":dif>0?"Uber rinde <strong class='pos'>"+fmtUSD(dif)+"/h más</strong> que Lyft.":"Lyft rinde <strong class='pos'>"+fmtUSD(-dif)+"/h más</strong> que Uber.")+"</p>";
  }
  $("comparativa").innerHTML=html;
}

/* ================= REGISTRAR ================= */
function formDefaults(){
  if(!$("f-fecha").value) $("f-fecha").value=todayISO();
  if(!$("f-gas").value) $("f-gas").value=settings.gasPrice;
}
function readForm(){
  return {
    fecha:$("f-fecha").value, plataforma:$("f-plataforma").value,
    inicio:$("f-inicio").value, fin:$("f-fin").value,
    bruto:parseFloat($("f-bruto").value),
    millas_pax:parseFloat($("f-millasPax").value),
    millas_muertas:parseFloat($("f-millasMuertas").value),
    bono:parseFloat($("f-bono").value||"0"),
    gas_price:parseFloat($("f-gas").value),
    maintenance:settings.maintenance,
    zona:$("f-zona").value.trim()
  };
}
function validateShift(s){
  const errs=[];
  if(!s.fecha) errs.push("Falta la fecha.");
  if(!s.inicio||!s.fin) errs.push("Faltan las horas de inicio y fin.");
  else if(parseHM(s.fin)<=parseHM(s.inicio)) errs.push("La hora de fin debe ser posterior a la de inicio.");
  [["bruto",s.bruto],["millas con pasajero",s.millas_pax],["millas muertas",s.millas_muertas],
   ["bono",s.bono],["precio de gasolina",s.gas_price]].forEach(x=>{
    if(isNaN(x[1])) errs.push("Falta el valor de "+x[0]+".");
    else if(x[1]<0) errs.push("El valor de "+x[0]+" no puede ser negativo.");
  });
  return errs;
}
function updatePreview(){
  const s=readForm(), errs=validateShift(s);
  if(errs.length){ $("pv-neto").textContent="—"; $("pv-netoh").textContent="—"; $("pv-costomi").textContent="—"; $("pv-irs").textContent=""; return; }
  const c=computeShift(s);
  $("pv-neto").textContent=fmtUSD(c.neto); $("pv-neto").className="num "+(c.neto>=0?"good":"bad");
  $("pv-netoh").textContent=fmtUSD(c.netoHora)+"/h"; $("pv-netoh").className="num "+(c.netoHora>=0?"good":"bad");
  $("pv-costomi").textContent="$"+fmtNum(c.costoPorMilla,3)+"/mi";
  $("pv-irs").textContent="ⓘ IRS referencia: "+fmtNum(c.millasTot,1)+" mi × $0.76 = "+fmtUSD(c.irsRef)+" (no se resta del neto)";
}
["f-fecha","f-plataforma","f-inicio","f-fin","f-bruto","f-bono","f-millasPax","f-millasMuertas","f-gas","f-zona"]
  .forEach(id=>$(id).addEventListener("input",updatePreview));
$("shift-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const s=readForm(), errs=validateShift(s), box=$("form-errors");
  if(errs.length){ box.innerHTML=errs.map(esc).join("<br>"); box.classList.add("show"); return; }
  box.classList.remove("show");
  try{
    if(editingId) await api("/shifts/"+editingId,{method:"PUT",body:JSON.stringify(s)});
    else await api("/shifts",{method:"POST",body:JSON.stringify(s)});
    resetForm(); await refreshAll(); goto("resumen");
  }catch(err){ box.textContent="⚠️ "+err.message; box.classList.add("show"); }
});
function resetForm(){
  editingId=null;
  ["f-inicio","f-fin","f-bruto","f-millasPax","f-millasMuertas","f-zona"].forEach(id=>$(id).value="");
  $("f-bono").value="0"; $("f-plataforma").value="uber";
  $("f-fecha").value=todayISO(); $("f-gas").value=settings.gasPrice;
  $("form-title").textContent="➕ Registrar turno";
  $("form-submit").textContent="💾 Guardar turno";
  $("form-cancel").style.display="none";
  updatePreview();
}
$("form-cancel").addEventListener("click",resetForm);
function editShift(id){
  const s=shifts.find(x=>x.id===id); if(!s) return;
  editingId=id;
  $("f-fecha").value=s.fecha; $("f-plataforma").value=s.plataforma;
  $("f-inicio").value=s.inicio; $("f-fin").value=s.fin;
  $("f-bruto").value=s.bruto; $("f-bono").value=s.bono;
  $("f-millasPax").value=s.millas_pax; $("f-millasMuertas").value=s.millas_muertas;
  $("f-gas").value=s.gas_price; $("f-zona").value=s.zona||"";
  $("form-title").textContent="✏️ Editar turno";
  $("form-submit").textContent="💾 Guardar cambios";
  $("form-cancel").style.display="block";
  goto("registrar"); updatePreview();
}
async function deleteShift(id){
  const s=shifts.find(x=>x.id===id); if(!s) return;
  if(!confirm("¿Borrar el turno del "+fmtFecha(s.fecha)+" ("+platLabel(s.plataforma)+")? No se puede deshacer.")) return;
  try{ await api("/shifts/"+id,{method:"DELETE"}); shifts=await api("/shifts"); renderHistorial(); }
  catch(err){ alert("⚠️ "+err.message); }
}

/* ================= HISTORIAL ================= */
function renderHistorial(){
  const has=shifts.length>0;
  $("historial-empty").style.display=has?"none":"block";
  $("historial-content").style.display=has?"block":"none";
  if(!has) return;
  const arr=shifts.slice().sort((a,b)=>sortDesc?(a.fecha<b.fecha?1:a.fecha>b.fecha?-1:(a.inicio<b.inicio?1:-1)):(a.fecha>b.fecha?1:a.fecha<b.fecha?-1:(a.inicio>b.inicio?1:-1)));
  $("hist-count").textContent=arr.length+" turnos";
  $("sort-toggle").textContent=sortDesc?"Orden: más recientes ↓":"Orden: más antiguos ↑";
  $("hist-body").innerHTML=arr.map(s=>{
    const c=computeShift(s);
    return "<tr>"
      +"<td>"+esc(fmtFecha(s.fecha))+"<br><span class='muted'>"+esc(s.inicio)+"–"+esc(s.fin)+"</span></td>"
      +"<td><span class='badge "+esc(s.plataforma)+"'>"+platLabel(s.plataforma)+"</span></td>"
      +"<td class='num'>"+fmtNum(c.horas)+"</td>"
      +"<td class='num'>"+fmtUSD(s.bruto)+"</td>"
      +"<td class='num "+(c.neto>=0?"pos":"neg")+"'>"+fmtUSD(c.neto)+"</td>"
      +"<td class='num "+(c.netoHora>=0?"pos":"neg")+"'>"+fmtUSD(c.netoHora)+"</td>"
      +"<td class='num'>"+fmtUSD(c.porMilla)+"</td>"
      +"<td style='white-space:normal;min-width:120px'>"+esc(s.zona||"—")+"<br><span class='muted' style='font-size:.72rem'>IRS ref "+fmtUSD(c.irsRef)+"</span></td>"
      +"<td><button class='btn ghost small' onclick='editShift("+s.id+")'>✏️</button>"
      +" <button class='btn ghost small' onclick='deleteShift("+s.id+")'>🗑</button></td>"
      +"</tr>";
  }).join("");
}
$("sort-toggle").addEventListener("click",()=>{sortDesc=!sortDesc;renderHistorial();});

/* ================= GRÁFICOS (SVG inline, sin librerías) ================= */
function vbarChart(items,opts){
  opts=opts||{};
  const W=640,H=250,padL=52,padB=34,padT=18;
  const vals=items.map(i=>i.value);
  const maxV=Math.max.apply(null,vals.concat([0])), minV=Math.min.apply(null,vals.concat([0]));
  const span=(maxV-minV)||1, y=v=>padT+(1-(v-minV)/span)*(H-padT-padB);
  const n=items.length, slot=(W-padL-8)/n, bw=Math.max(2,Math.min(34,slot*0.62));
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img">';
  for(let g=0;g<=4;g++){ const v=minV+span*g/4, yy=y(v);
    s+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-4)+'" y2="'+yy+'" stroke="#2b3752" stroke-width="1" opacity="0.6"/>'
      +'<text x="'+(padL-6)+'" y="'+(yy+4)+'" fill="#6b7690" font-size="11" text-anchor="end">$'+Math.round(v)+'</text>'; }
  const y0=y(0);
  s+='<line x1="'+padL+'" y1="'+y0+'" x2="'+(W-4)+'" y2="'+y0+'" stroke="#9aa5bd" stroke-width="1"/>';
  items.forEach((it,idx)=>{
    const cx=padL+8+slot*idx+slot/2, x=cx-bw/2, yy=y(it.value);
    const top=Math.min(yy,y0), hgt=Math.max(1.5,Math.abs(yy-y0));
    const col=it.color||(it.value>=0?"#85bb65":"#e0605e");
    s+='<rect x="'+x.toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+hgt.toFixed(1)+'" rx="3" fill="'+col+'">'
      +'<title>'+esc(it.tip||(it.label+": "+fmtUSD(it.value)))+'</title></rect>';
    if(opts.showValues&&bw>14&&hgt>16)
      s+='<text x="'+cx.toFixed(1)+'" y="'+(top-5).toFixed(1)+'" fill="#e9edf5" font-size="10" text-anchor="middle">'+Math.round(it.value)+'</text>';
    if(!opts.labelEvery||idx%opts.labelEvery===0)
      s+='<text x="'+cx.toFixed(1)+'" y="'+(H-8)+'" fill="#6b7690" font-size="10" text-anchor="middle">'+esc(it.label)+'</text>';
  });
  return s+'</svg>';
}
function renderGraficos(){
  const has=shifts.length>0;
  $("graficos-empty").style.display=has?"none":"block";
  $("graficos-content").style.display=has?"block":"none";
  if(!has) return;
  const days=[], d=new Date();
  for(let i=29;i>=0;i--){ const t=new Date(d); t.setDate(d.getDate()-i);
    const iso=t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");
    days.push({iso:iso,lbl:String(t.getDate())+"/"+String(t.getMonth()+1),neto:0,horas:0,n:0}); }
  const map={}; days.forEach(x=>map[x.iso]=x);
  shifts.forEach(s=>{ if(map[s.fecha]){ const c=computeShift(s); map[s.fecha].neto+=c.neto; map[s.fecha].horas+=c.horas; map[s.fecha].n++; } });
  $("chart-dia").innerHTML=vbarChart(days.map(x=>{
    const v=x.horas>0?x.neto/x.horas:0;
    return {label:x.lbl,value:Math.round(v*100)/100,
      tip:fmtFecha(x.iso)+" — "+x.n+" turno(s) · neto "+fmtUSD(x.neto)+" · "+fmtNum(x.horas)+" h · neto/h "+fmtUSD(v)};
  }),{labelEvery:5});
  const gp={uber:{neto:0,horas:0,n:0},lyft:{neto:0,horas:0,n:0},ambas:{neto:0,horas:0,n:0}};
  shifts.forEach(s=>{ const c=computeShift(s); if(gp[s.plataforma]){gp[s.plataforma].neto+=c.neto;gp[s.plataforma].horas+=c.horas;gp[s.plataforma].n++;} });
  $("chart-plat").innerHTML=vbarChart(["uber","lyft","ambas"].map(p=>{
    const g=gp[p], v=g.horas>0?g.neto/g.horas:0;
    return {label:platLabel(p),value:Math.round(v*100)/100,
      color:p==="uber"?"#85bb65":p==="lyft"?"#c58af0":"#5aa9e6",
      tip:platLabel(p)+" — "+g.n+" turno(s) · neto "+fmtUSD(g.neto)+" · "+fmtNum(g.horas)+" h · neto/h "+fmtUSD(v)};
  }),{labelEvery:1,showValues:true});
  const hh=[]; for(let h=0;h<24;h++) hh.push({h:h,neto:0,n:0});
  shifts.forEach(s=>{ const hr=parseInt(String(s.inicio).split(":")[0],10); if(!isNaN(hr)){ const c=computeShift(s); hh[hr].neto+=c.neto; hh[hr].n++; } });
  $("chart-hora").innerHTML=vbarChart(hh.map(x=>({label:String(x.h).padStart(2,"0"),value:Math.round(x.neto*100)/100,
    tip:x.label+":00 — "+x.n+" turno(s) · neto total "+fmtUSD(x.neto)})),{labelEvery:3});
}

/* ================= EXPORTAR / IMPORTAR CSV ================= */
const CSV_COLS=["fecha","plataforma","inicio","fin","bruto","millas_pax","millas_muertas","bono","gas_price","maintenance","zona"];
function csvCell(v){ v=String(v==null?"":v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
$("btn-export").addEventListener("click",()=>{
  if(!shifts.length){ $("import-msg").textContent="No hay turnos para exportar."; return; }
  const lines=[CSV_COLS.join(",")];
  shifts.forEach(s=>lines.push(CSV_COLS.map(c=>csvCell(s[c])).join(",")));
  const blob=new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="rs-turnos-"+todayISO()+".csv"; document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},800);
  $("import-msg").textContent="CSV exportado con "+shifts.length+" turnos.";
});
function parseCSVLine(line){
  const out=[]; let cur="",q=false;
  for(let i=0;i<line.length;i++){ const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true; else if(ch===","){out.push(cur);cur="";} else cur+=ch; }
  out.push(cur); return out;
}
$("file-import").addEventListener("change",function(){
  const f=this.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=async function(){
    const lines=String(r.result).split(/\r?\n/).filter(l=>l.trim().length);
    if(lines.length<2){ $("import-msg").textContent="El CSV está vacío."; return; }
    const head=parseCSVLine(lines[0]).map(h=>h.trim());
    let ok=0,skip=0;
    for(let i=1;i<lines.length;i++){
      const cells=parseCSVLine(lines[i]), row={};
      head.forEach((h,j)=>row[h]=cells[j]);
      const s={fecha:row.fecha||todayISO(),
        plataforma:["uber","lyft","ambas"].indexOf(row.plataforma)>=0?row.plataforma:"uber",
        inicio:row.inicio||"09:00", fin:row.fin||"10:00",
        bruto:parseFloat(row.bruto), millas_pax:parseFloat(row.millas_pax),
        millas_muertas:parseFloat(row.millas_muertas), bono:parseFloat(row.bono||"0"),
        gas_price:parseFloat(row.gas_price), maintenance:parseFloat(row.maintenance),
        zona:row.zona||""};
      if(isNaN(s.maintenance)) s.maintenance=settings.maintenance;
      if(validateShift(s).length){ skip++; continue; }
      try{ await api("/shifts",{method:"POST",body:JSON.stringify(s)}); ok++; }
      catch(e){ skip++; }
    }
    shifts=await api("/shifts"); renderHistorial();
    $("import-msg").textContent="Importados "+ok+" turnos."+(skip?" ("+skip+" filas omitidas.)":"");
  };
  r.readAsText(f); this.value="";
});

/* ================= AJUSTES ================= */
function renderSettings(){ $("s-gas").value=settings.gasPrice; $("s-maint").value=settings.maintenance; }
$("btn-save-settings").addEventListener("click",()=>{
  const v={gasPrice:parseFloat($("s-gas").value), maintenance:parseFloat($("s-maint").value)};
  const bad=[];
  if(!(v.gasPrice>=0)) bad.push("precio de gasolina no puede ser negativo");
  if(!(v.maintenance>=0)) bad.push("mantenimiento no puede ser negativo");
  if(bad.length){ $("settings-msg").textContent="⚠️ "+bad.join(" · "); return; }
  settings=Object.assign({},settings,v); saveSettings(settings);
  $("f-gas").value=settings.gasPrice; updatePreview();
  $("settings-msg").textContent="✅ Ajustes guardados. Se usan como default al registrar turnos.";
});
$("btn-wipe").addEventListener("click",async ()=>{
  if(shifts.length && confirm("¿Borrar TODOS los ("+shifts.length+") turnos de tu cuenta? No se puede deshacer.")){
    for(const s of shifts){ try{ await api("/shifts/"+s.id,{method:"DELETE"}); }catch(e){} }
    await refreshAll();
  }
});

/* ================= ADMIN (solo rol admin) ================= */
async function loadAdminUsers(){
  let card=$("admin-card");
  if(!card){
    card=document.createElement("div"); card.className="card"; card.id="admin-card";
    card.innerHTML='<h2>👤 Administración de usuarios</h2><div id="admin-users"></div>'
      +'<h3>Crear usuario</h3><div class="form-grid">'
      +'<div class="field"><label>Usuario</label><input type="text" id="a-user"></div>'
      +'<div class="field"><label>Rol</label><select id="a-role"><option value="driver">driver</option><option value="admin">admin</option></select></div>'
      +'<div class="field full"><label>Contraseña (vacío = generar una segura)</label><input type="text" id="a-pass" placeholder="se genera automáticamente si lo dejás vacío"></div></div>'
      +'<button class="btn primary" id="a-create">Crear usuario</button><p class="muted" id="a-msg"></p>';
    document.querySelector("#view-datos").appendChild(card);
    $("a-create").addEventListener("click", async ()=>{
      try{
        const out=await api("/admin/users",{method:"POST",body:JSON.stringify(
          {username:$("a-user").value.trim(), role:$("a-role").value, password:$("a-pass").value})});
        $("a-msg").innerHTML="✅ Usuario <strong>"+esc(out.username)+"</strong> creado."
          +(out.password_once?'<br>🔑 Contraseña (se muestra <strong>una sola vez</strong>): <code>'+esc(out.password_once)+'</code><br><span class="muted">Copiala y entregala ahora; no vuelve a mostrarse.</span>':"");
        $("a-user").value=""; $("a-pass").value=""; loadAdminUsers();
      }catch(err){ $("a-msg").textContent="⚠️ "+err.message; }
    });
  }
  try{
    const users=await api("/admin/users");
    $("admin-users").innerHTML='<div class="table-wrap"><table style="min-width:0"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>'
      +users.map(u=>"<tr><td>"+esc(u.username)+"</td><td>"+esc(u.role)+"</td><td>"+(u.active?"activo":"inactivo")+"</td>"
        +"<td>"+(u.active&&u.username!==me.username?'<button class="btn ghost small" onclick="deactivateUser('+u.id+')">Desactivar</button>':"")+"</td></tr>").join("")
      +"</tbody></table></div>";
  }catch(e){ /* sin permiso */}
}
async function deactivateUser(id){
  if(!confirm("¿Desactivar este usuario? Se cierran sus sesiones.")) return;
  try{ await api("/admin/users/"+id+"/deactivate",{method:"POST"}); loadAdminUsers(); }
  catch(err){ alert("⚠️ "+err.message); }
}

/* ================= INIT ================= */
window.editShift=editShift; window.deleteShift=deleteShift; window.deactivateUser=deactivateUser;
formDefaults(); renderSettings(); updatePreview(); checkAuth();
