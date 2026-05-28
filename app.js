/**
 * LeafDiag — app.js v3.1 (Mis à jour avec Sauvegarde Physique)
 * Application généraliste d'analyse de symptômes foliaires.
 * Aucune mention de pathogène spécifique dans l'interface.
 * Les détails techniques sont masqués — interface grand public.
 */

'use strict';

let cvReady    = false;
let imgLoaded  = false;
let currentImg = null;
let lastResult = null;

const PARAMS = {
  P_SAIN_L    : 20,
  P_SAIN_S    : 70,
  P_INFECTE_L : 75,
  P_INFECTE_S : 35,
  WL : 2.0,  Wa : 0.5,  Wb : 1.0,
  SEUIL       : 0.50,
  MIN_PLAGE_PX: 300,
  TARGET_W    : 800,
};

// ═══════════════════════════════════════════════════════════════
// INIT OpenCV
// ═══════════════════════════════════════════════════════════════
function onOpenCvReady() {
  cvReady = true;
  document.getElementById('loading-msg').textContent = 'Moteur prêt ✓';
  setTimeout(() => switchScreen('screen-loading', 'screen-main'), 600);
}
function onOpenCvError() {
  document.getElementById('loading-msg').textContent =
    '⚠ Impossible de charger OpenCV.js — vérifiez votre connexion.';
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════
function switchScreen(fromId, toId) {
  document.getElementById(fromId).classList.remove('active');
  const t = document.getElementById(toId);
  t.classList.add('active');
  t.style.display = 'flex';
}
function showMain()    { switchScreen('screen-history', 'screen-main'); }
function showHistory() { renderHistory(); switchScreen('screen-main', 'screen-history'); }

// ═══════════════════════════════════════════════════════════════
// CAPTURE IMAGE
// ═══════════════════════════════════════════════════════════════
function openCamera()    { document.getElementById('input-camera').click(); }
function openGallery()   { document.getElementById('input-gallery').click(); }
function triggerCapture(){ if (!imgLoaded) openGallery(); }

function handleFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      currentImg = img;
      imgLoaded  = true;
      const prev = document.getElementById('preview-img');
      prev.src = e.target.result;
      prev.style.display = 'block';
      document.getElementById('scan-placeholder').style.display = 'none';
      document.getElementById('btn-analyze').disabled = false;
      document.getElementById('results-section').style.display = 'none';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

// ═══════════════════════════════════════════════════════════════
// ACCÈS ET REQUÊTE COMMANDE DE DIAGNOSTIC
// ═══════════════════════════════════════════════════════════════
function runAnalysis() {
  if (!cvReady || !imgLoaded || !currentImg) return;
  showAnalyzingOverlay(true);
  setTimeout(() => {
    try {
      const result = analyzeLeaf(currentImg);
      lastResult = result;
      displayResults(result);
    } catch(err) {
      showToast('Erreur analyse : ' + err.message);
      console.error(err);
    } finally {
      showAnalyzingOverlay(false);
    }
  }, 80);
}

// ═══════════════════════════════════════════════════════════════
// ALGORITHME — analyse colorimétrique Lab auto-calibrée
// ═══════════════════════════════════════════════════════════════
function analyzeLeaf(imgEl) {
  const P  = PARAMS;
  const tW = P.TARGET_W;
  const tH = Math.round(imgEl.naturalHeight * (tW / imgEl.naturalWidth));

  // 1. Charger dans Mat BGR
  const tmp = document.createElement('canvas');
  tmp.width = tW; tmp.height = tH;
  tmp.getContext('2d').drawImage(imgEl, 0, 0, tW, tH);
  const src = cv.imread(tmp);
  const bgr = new cv.Mat();
  cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
  src.delete();

  // 2. Espaces couleur
  const hsvMat = new cv.Mat();
  const labMat = new cv.Mat();
  cv.cvtColor(bgr, hsvMat, cv.COLOR_BGR2HSV);
  cv.cvtColor(bgr, labMat, cv.COLOR_BGR2Lab);

  // 3. Segmentation feuille par plage HSV verte
  const maskGreen = new cv.Mat();
  const lowerHSV  = new cv.Mat(tH, tW, cv.CV_8UC3);
  const upperHSV  = new cv.Mat(tH, tW, cv.CV_8UC3);
  lowerHSV.setTo(new cv.Scalar(25,  30,  20, 0));
  upperHSV.setTo(new cv.Scalar(95, 255, 240, 0));
  cv.inRange(hsvMat, lowerHSV, upperHSV, maskGreen);
  lowerHSV.delete(); upperHSV.delete();

  const k11 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11,11));
  const k5  = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5,5));
  cv.morphologyEx(maskGreen, maskGreen, cv.MORPH_CLOSE, k11);
  cv.morphologyEx(maskGreen, maskGreen, cv.MORPH_OPEN,  k5);
  k11.delete(); k5.delete();

  const contoursVec = new cv.MatVector();
  const hierMat     = new cv.Mat();
  cv.findContours(maskGreen, contoursVec, hierMat,
                  cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  hierMat.delete(); maskGreen.delete();

  if (contoursVec.size() === 0)
    throw new Error('Aucune feuille détectée — vérifiez l\'image.');

  let maxArea = 0, maxIdx = 0;
  for (let i = 0; i < contoursVec.size(); i++) {
    const a = cv.contourArea(contoursVec.get(i));
    if (a > maxArea) { maxArea = a; maxIdx = i; }
  }

  const leafMask = new cv.Mat.zeros(tH, tW, cv.CV_8UC1);
  {
    const v = new cv.MatVector();
    v.push_back(contoursVec.get(maxIdx));
    cv.drawContours(leafMask, v, 0, new cv.Scalar(255,0,0,0), -1);
    v.delete();
  }
  const nLimbe = cv.countNonZero(leafMask);

  // 4. Exclusion nervures (V < µV − 1σ)
  const hsvChans = new cv.MatVector();
  cv.split(hsvMat, hsvChans);
  const vCh = hsvChans.get(2);
  const sCh = hsvChans.get(1);

  const vVals = getPixelValues(vCh, leafMask);
  const muV   = mean(vVals);
  const sigV  = std(vVals, muV);

  const nervMask = new cv.Mat();
  cv.threshold(vCh, nervMask, muV - 1.0*sigV, 255, cv.THRESH_BINARY_INV);
  applyMask(nervMask, leafMask);
  const k5b = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5,5));
  cv.dilate(nervMask, nervMask, k5b);
  k5b.delete();

  const parMask = new cv.Mat();
  cv.subtract(leafMask, nervMask, parMask);
  applyMask(parMask, leafMask);
  const nParen = cv.countNonZero(parMask);
  if (nParen === 0) throw new Error('Parenchyme vide — image invalide.');

  // 5. Canaux Lab
  const labChans = new cv.MatVector();
  cv.split(labMat, labChans);
  const lCh = labChans.get(0);
  const aCh = labChans.get(1);
  const bCh = labChans.get(2);

  // 6. Auto-calibration signatures
  const lVals = getPixelValues(lCh, parMask);
  const sVals = getPixelValues(sCh, parMask);
  const p20L  = percentile(lVals, P.P_SAIN_L);
  const p70S  = percentile(sVals, P.P_SAIN_S);
  const p75L  = percentile(lVals, P.P_INFECTE_L);
  const p35S  = percentile(sVals, P.P_INFECTE_S);

  const lD=lCh.data, aD=aCh.data, bD=bCh.data, sD=sCh.data, pD=parMask.data;
  let sL=0,sA=0,sB=0,sN=0, iL=0,iA=0,iB=0,iN=0;
  for (let i=0; i<pD.length; i++) {
    if (!pD[i]) continue;
    const lv=lD[i],sv=sD[i],av=aD[i],bv=bD[i];
    if (lv < p20L && sv > p70S) { sL+=lv;sA+=av;sB+=bv;sN++; }
    if (lv > p75L && sv < p35S) { iL+=lv;iA+=av;iB+=bv;iN++; }
  }
  if (sN===0||iN===0)
    throw new Error('Contraste insuffisant — impossible de calibrer l\'analyse.');

  const REF_SAIN = [sL/sN, sA/sN, sB/sN];
  const REF_SYMP = [iL/iN, iA/iN, iB/iN];
  const deltaL   = REF_SYMP[0] - REF_SAIN[0];

  // 7. Score distance Lab pondérée
  const {WL,Wa,Wb,SEUIL} = P;
  const scoreArr = new Float32Array(tW*tH);
  for (let i=0; i<pD.length; i++) {
    if (!pD[i]) continue;
    const l=lD[i],a=aD[i],b=bD[i];
    const dS = Math.sqrt(WL*(l-REF_SAIN[0])**2+Wa*(a-REF_SAIN[1])**2+Wb*(b-REF_SAIN[2])**2);
    const dI = Math.sqrt(WL*(l-REF_SYMP[0])**2+Wa*(a-REF_SYMP[1])**2+Wb*(b-REF_SYMP[2])**2);
    scoreArr[i] = dS / (dS+dI+1e-6);
  }

  // 8. Masque binaire + re-masquage obligatoire après chaque morpho
  const infRaw = new cv.Mat.zeros(tH, tW, cv.CV_8UC1);
  for (let i=0; i<pD.length; i++)
    if (pD[i] && scoreArr[i] > SEUIL) infRaw.data[i]=255;

  const k5c  = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5,5));
  const k11b = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11,11));
  cv.morphologyEx(infRaw, infRaw, cv.MORPH_OPEN,  k5c);
  applyMask(infRaw, parMask);       // ← re-masquage
  cv.morphologyEx(infRaw, infRaw, cv.MORPH_CLOSE, k11b);
  applyMask(infRaw, parMask);       // ← re-masquage
  k5c.delete(); k11b.delete();

  const cnts2 = new cv.MatVector();
  const hier2 = new cv.Mat();
  cv.findContours(infRaw, cnts2, hier2, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  hier2.delete();

  const infFinal = new cv.Mat.zeros(tH, tW, cv.CV_8UC1);
  for (let i=0; i<cnts2.size(); i++) {
    if (cv.contourArea(cnts2.get(i)) > P.MIN_PLAGE_PX) {
      const v = new cv.MatVector();
      v.push_back(cnts2.get(i));
      cv.drawContours(infFinal, v, 0, new cv.Scalar(255,0,0,0), -1);
      v.delete();
    }
  }
  cnts2.delete();
  applyMask(infFinal, parMask);     // ← re-masquage final

  // 9. Sévérité — garantie 0–100 %
  const nInf    = cv.countNonZero(infFinal);
  const severity = Math.min(nInf / nParen * 100, 100);

  // 10. Rendu
  const heatmapCanvas = renderHeatmap(bgr, scoreArr, parMask, leafMask,
                                      contoursVec, maxIdx, tW, tH);
  const maskCanvas    = renderMask(bgr, infFinal, contoursVec, maxIdx, tW, tH);

  // Nettoyage
  [bgr,hsvMat,labMat,leafMask,nervMask,parMask,
   lCh,aCh,bCh,vCh,sCh,infRaw,infFinal].forEach(m=>{try{m.delete();}catch(e){}});
  [hsvChans,labChans,contoursVec].forEach(v=>{try{v.delete();}catch(e){}});

  return { severity, nInf, nParen, nLimbe, deltaL, heatmapCanvas, maskCanvas };
}

// ─── Helpers ────────────────────────────────────────────────────
function getPixelValues(mat,mask){
  const d=mat.data,m=mask.data,out=[];
  for(let i=0;i<m.length;i++) if(m[i]) out.push(d[i]);
  return out;
}
function mean(arr){ return arr.reduce((s,v)=>s+v,0)/arr.length; }
function std(arr,mu){
  if(mu===undefined) mu=mean(arr);
  return Math.sqrt(arr.reduce((s,v)=>s+(v-mu)**2,0)/arr.length);
}
function percentile(arr,p){
  const s=[...arr].sort((a,b)=>a-b);
  return s[Math.floor(p/100*(s.length-1))];
}
function applyMask(dst,mask){
  const dd=dst.data,md=mask.data;
  for(let i=0;i<dd.length;i++) if(!md[i]) dd[i]=0;
}

// ═══════════════════════════════════════════════════════════════
// RENDU HEATMAP
// ═══════════════════════════════════════════════════════════════
function renderHeatmap(bgr, scoreArr, parMask, leafMask, contours, cntIdx, W, H){
  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  const rgba=new cv.Mat();
  cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data),W,H),0,0);
  rgba.delete();
  const imgd=ctx.getImageData(0,0,W,H);
  const od=imgd.data, pd=parMask.data;
  for(let i=0;i<scoreArr.length;i++){
    if(!pd[i]) continue;
    const s=Math.min(scoreArr[i],1);
    const R=Math.min(s*2.2,1), G=Math.max(1-s*1.8,0.05);
    const px=i*4;
    od[px]  =Math.round(od[px]  *0.28);
    od[px+1]=Math.round(od[px+1]*0.28+G*255*0.72);
    od[px+2]=Math.round(od[px+2]*0.28+R*255*0.72);
  }
  ctx.putImageData(imgd,0,0);
  drawCnt(ctx,contours,cntIdx,'#00dc00',2);
  return canvas;
}

// ═══════════════════════════════════════════════════════════════
// RENDU MASQUE
// ═══════════════════════════════════════════════════════════════
function renderMask(bgr, infFinal, contours, cntIdx, W, H){
  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  const rgba=new cv.Mat();
  cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data),W,H),0,0);
  rgba.delete();
  const imgd=ctx.getImageData(0,0,W,H);
  const od=imgd.data, md=infFinal.data;
  for(let i=0;i<md.length;i++){
    if(!md[i]) continue;
    const px=i*4;
    od[px]  =Math.round(od[px]  *0.50+30 *0.50);
    od[px+1]=Math.round(od[px+1]*0.50+30 *0.50);
    od[px+2]=Math.round(od[px+2]*0.50+220*0.50);
  }
  ctx.putImageData(imgd,0,0);
  drawCnt(ctx,contours,cntIdx,'#00dc00',2);
  return canvas;
}

function drawCnt(ctx,contours,idx,color,lw){
  if(!contours||idx===undefined) return;
  const pts=contours.get(idx).data32S;
  if(!pts||pts.length<4) return;
  ctx.beginPath(); ctx.moveTo(pts[0],pts[1]);
  for(let i=2;i<pts.length;i+=2) ctx.lineTo(pts[i],pts[i+1]);
  ctx.closePath(); ctx.strokeStyle=color; ctx.lineWidth=lw; ctx.stroke();
}

// ═══════════════════════════════════════════════════════════════
// AFFICHAGE RÉSULTATS — interface grand public
// ═══════════════════════════════════════════════════════════════
function displayResults(r){
  const {severity, heatmapCanvas, maskCanvas} = r;
  const pct = severity.toFixed(1);

  // Badge niveau
  const badge = document.getElementById('severity-badge');
  badge.className = 'severity-badge';
 if      (severity < 5)  { badge.textContent='⬤ Faible'; badge.classList.add('badge-low'); }
 else if (severity < 20) { badge.textContent='⬤ Modéré'; badge.classList.add('badge-mod'); }
  else if (severity < 40) { badge.textContent='⬤ Élevé';  badge.classList.add('badge-high'); }
 else                    { badge.textContent='⬤ Sévère'; badge.classList.add('badge-severe'); }

  // Barre + grand pourcentage
  document.getElementById('sev-bar-fill').style.width = Math.min(severity,100)+'%';
  document.getElementById('m-severity').textContent   = pct+'%';

  // Canvases
  const cHm=document.getElementById('canvas-heatmap');
  const cMk=document.getElementById('canvas-mask');
  cHm.width=heatmapCanvas.width; cHm.height=heatmapCanvas.height;
  cMk.width=maskCanvas.width;    cMk.height=maskCanvas.height;
  cHm.getContext('2d').drawImage(heatmapCanvas,0,0);
  cMk.getContext('2d').drawImage(maskCanvas,0,0);

  // Message de niveau — simple, universel, sans mention de pathogène spécifique
  const niveaux = [
    [0,  5,  '',  '#2e6b0e',
     ''],
    [5,  20, '',  '#7a5200',
     ''],
    [20, 40, '',   '#7a3200',
     ''],
    [40, 101,'',  '#7a0e0e',
     ''],
  ];
  const niv = niveaux.find(([lo,hi])=>severity>=lo&&severity<hi);
  if (niv) {
    document.getElementById('level-box').innerHTML =
      `<strong style="color:${niv[3]}">${niv[2]}</strong><br>${niv[4]}`;
  }

  document.getElementById('results-section').style.display='flex';
  document.getElementById('results-section').scrollIntoView({behavior:'smooth'});
  showViz('heatmap');
}

function showViz(type){
  document.getElementById('canvas-heatmap').style.display=type==='heatmap'?'block':'none';
  document.getElementById('canvas-mask').style.display   =type==='mask'   ?'block':'none';
  document.getElementById('btn-heatmap').classList.toggle('active',type==='heatmap');
  document.getElementById('btn-mask').classList.toggle('active',   type==='mask');
}

// ═══════════════════════════════════════════════════════════════
// HISTORIQUE ET SAUVEGARDE PHYSIQUE WINDOWS
// ═══════════════════════════════════════════════════════════════
async function saveResult(){
  if(!lastResult || !currentImg) return;
  
  // A. Étape 1 : Sauvegarde dans l'historique interne (miniature de l'application)
  const h=getHistory();
  const tc=document.createElement('canvas'); tc.width=60; tc.height=60;
  tc.getContext('2d').drawImage(currentImg,0,0,60,60);
  h.unshift({
    id      : Date.now(),
    date    : new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'short',
              year:'numeric',hour:'2-digit',minute:'2-digit'}),
    severity: lastResult.severity.toFixed(1),
    thumb   : tc.toDataURL('image/jpeg',0.5),
  });
  localStorage.setItem('leafdiag_history',JSON.stringify(h.slice(0,50)));
  
  // B. Étape 2 : Déclenchement de l'export d'image vers le répertoire PC (ex: disque D:)
  const canvasHeatmap = document.getElementById('canvas-heatmap');
  const dateStr = new Date().toISOString().slice(0,10);
  const timeStr = new Date().toTimeString().slice(0,8).replace(/:/g, "-");
  const defaultName = `Diagnostic_LeafDiag_${dateStr}_${timeStr}.png`;

  // Utilisation de l'API moderne d'accès au système de fichiers (File System Access)
  if ('showSaveFilePicker' in window) {
    try {
      const options = {
        suggestedName: defaultName,
        types: [{
          description: 'Image PNG Diagnostic',
          accept: { 'image/png': ['.png'] },
        }],
      };
      
      // Ouvre l'explorateur Windows pour vous laisser choisir le répertoire (ex: D:\votre_dossier)
      const handle = await window.showSaveFilePicker(options);
      const writable = await handle.createWritable();
      
      canvasHeatmap.toBlob(async (blob) => {
        await writable.write(blob);
        await writable.close();
        showToast('Rapport exporté et sauvegardé ✓');
      }, 'image/png');

    } catch (err) {
      // Si l'utilisateur clique juste sur "Annuler", on ne fait rien
      if (err.name !== 'AbortError') {
        console.error(err);
        fallbackDownload(canvasHeatmap, defaultName);
      }
    }
  } else {
    // Solution de secours standard si restrictions navigateur sur l'ancien OS
    fallbackDownload(canvasHeatmap, defaultName);
  }
}

// Fonction fallback pour téléchargement classique par ancrage invisible
function fallbackDownload(canvas, filename) {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Fichier envoyé vers Téléchargements ✓');
}

function getHistory(){
  try{return JSON.parse(localStorage.getItem('leafdiag_history')||'[]');}catch{return[];}
}
function clearHistory(){
  if(!confirm('Effacer tout l\'historique ?')) return;
  localStorage.removeItem('leafdiag_history'); renderHistory();
}
function renderHistory(){
  const list=document.getElementById('history-list');
  const items=getHistory();
  if(!items.length){
    list.innerHTML='<div class="history-empty">Aucune analyse sauvegardée.</div>';
    return;
  }
  list.innerHTML=items.map(it=>`
    <div class="history-item">
      <img class="history-thumb" src="${it.thumb}" alt="miniature">
      <div class="history-info">
        <div class="history-date">${it.date}</div>
        <div class="history-sev">Surface symptomatique : ${it.severity}%</div>
      </div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// UI UTILS
// ═══════════════════════════════════════════════════════════════
function resetApp(){
  currentImg=null; imgLoaded=false; lastResult=null;
  document.getElementById('preview-img').style.display='none';
  document.getElementById('scan-placeholder').style.display='';
  document.getElementById('btn-analyze').disabled=true;
  document.getElementById('results-section').style.display='none';
  window.scrollTo({top:0,behavior:'smooth'});
}
function showAnalyzingOverlay(show){
  let ov=document.getElementById('analyzing-overlay');
  if(!ov){
    ov=document.createElement('div'); ov.id='analyzing-overlay';
    ov.className='analyzing-overlay';
    ov.innerHTML='<div class="spinner"></div><p>Analyse en cours…</p>';
    document.body.appendChild(ov);
  }
  ov.classList.toggle('show',show);
}
let _tt;
function showToast(msg){
  let t=document.querySelector('.toast');
  if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t);}
  t.textContent=msg; t.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>t.classList.remove('show'),2800);
}

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════════════════════════
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>
    navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW:',e))
  );
}