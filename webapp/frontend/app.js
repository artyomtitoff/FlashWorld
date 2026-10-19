// FlashWorld Site Frontend — vanilla JS with Three + Spark
import * as THREE from "three";
import { SplatMesh, SparkControls } from "@sparkjsdev/spark";

// ---------- State ----------
let imageBase64 = null;
let imageResolution = null;
let backendOverride = "";
let currentTaskId = null;
let pollTimer = null;
let currentSplat = null;
let instructionSplat = null;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(0,0,1.6);
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));

const canvasWrap = document.getElementById("viewer-canvas");
let controls = null;

function initRenderer(){
  const w = canvasWrap.clientWidth || 704;
  const h = 520;
  renderer.setSize(w, h);
  canvasWrap.appendChild(renderer.domElement);
  // attach SparkControls after canvas is in DOM
  controls = new SparkControls({ canvas: renderer.domElement });
  // Keep wrapper size synced with resolution choice
  syncCanvasSize();
  console.log("[init] renderer", w, h);
}
function syncCanvasSize(){
  const res = document.getElementById("resolution").value; // NxHxW
  const parts = res.split("x").map(Number);
  const W = parts[2]||704, H = parts[1]||480;
  // Keep viewer aspect approx, but actual renderer size follows container width
  // We set canvas size to container width and H scaled proportionally?
  // Simpler: keep renderer at W x H but CSS scaled to fit.
  const cw = canvasWrap.clientWidth;
  const scale = Math.min(1, cw / W);
  const rw = Math.round(W * scale);
  const rh = Math.round(H * scale);
  renderer.setSize(rw, rh);
  camera.aspect = rw / rh;
  camera.updateProjectionMatrix();
  document.getElementById("stat-fov").textContent = document.getElementById("fov").value + "°";
}

// ---------- Helpers ----------
const $ = (s)=>document.querySelector(s);
const $$ = (s)=>document.querySelectorAll(s);
function apiBase(){
  const v = $("#backend-url").value.trim();
  if(v) return v.replace(/\/$/,"");
  return ""; // same origin
}
function fetchWithAuth(url, opts={}){
  const headers = new Headers(opts.headers || {});
  const token = $("#hf-token").value.trim();
  if(token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, {...opts, headers});
}
function setStatus(msg, state="ожидание"){
  $("#status-msg").textContent = msg;
  $("#status-state").textContent = state;
  $("#gen-status").textContent = msg;
}
function updateCamCount(){
  const n = cameraParams.length;
  $("#cam-count").textContent = n;
  $("#status-cam").textContent = n;
  $("#viewer-info").textContent = `камер ${n} • готовность: ${n>=2 ? "готово к генерации" : "нужно ещё "+(2-n)+" камеры"}`;
  // enable save
  const canSave = n>=2;
  $("#btn-save-traj").disabled = !canSave;
  $("#btn-download-json").disabled = false;
}

function showProgress(show, title="Генерация сцены...", pct=0, msg=""){
  const ov = $("#progress-overlay");
  if(show) ov.classList.add("show"); else ov.classList.remove("show");
  if(title) $("#progress-title").textContent = title;
  $("#progress-bar").style.width = pct + "%";
  $("#progress-text").textContent = `${Math.round(pct)}% • ${msg || "в процессе"}`;
  $("#progress-msg").textContent = msg || "Пожалуйста, подожди...";
}
function toast(msg){
  setStatus(msg, "инфо");
  console.log(msg);
}

// ---------- Camera handling ----------
const cameraParams = [];
const cameraSplats = [];
const interpSplats = [];

function createCameraSplat(cam, color=[1,1,1]){
  const mesh = new SplatMesh({
    constructSplats: (splats)=>{
      const N=900; const scales=new THREE.Vector3().setScalar(0.0012);
      const q=new THREE.Quaternion(); const opacity=1; const col=new THREE.Color(...color);
      const H=1000, W=1000*cam.aspect;
      const fx=0.5*H/Math.tan(0.5*cam.fov*Math.PI/180);
      const fy=fx;
      const xt=(0 - W/2 +0.5)/fy, xb=(W - W/2 +0.5)/fy;
      const yl=-(0 - H/2 +0.5)/fx, yr=-(H - H/2 +0.5)/fx;
      const L=0.12;
      const center=new THREE.Vector3(0,0,0);
      const lt=new THREE.Vector3(xt*L, yl*L, -L);
      const rt=new THREE.Vector3(xt*L, yr*L, -L);
      const lb=new THREE.Vector3(xb*L, yl*L, -L);
      const rb=new THREE.Vector3(xb*L, yr*L, -L);
      const lines=[[center,lt],[center,rt],[center,lb],[center,rb],[lt,rt],[lt,lb],[rt,rb],[lb,rb]];
      for(let i=0;i<lines.length;i++){
        for(let j=0;j<N;j++){
          const p=new THREE.Vector3().lerpVectors(lines[i][0], lines[i][1], j/N);
          splats.pushSplat(p, scales, q, opacity, col);
        }
      }
    }
  });
  mesh.position.copy(cam.position);
  mesh.quaternion.copy(cam.quaternion);
  return mesh;
}
function createCubeSplat(size=0.22, color=[1,1,1]){
  const mesh=new SplatMesh({
    constructSplats:(splats)=>{
      const N=900; const scales=new THREE.Vector3().setScalar(0.002);
      const q=new THREE.Quaternion(); const col=new THREE.Color(...color);
      const hs=size/2;
      const verts=[new THREE.Vector3(-hs,-hs,-hs),new THREE.Vector3(hs,-hs,-hs),new THREE.Vector3(hs,hs,-hs),new THREE.Vector3(-hs,hs,-hs),new THREE.Vector3(-hs,-hs,hs),new THREE.Vector3(hs,-hs,hs),new THREE.Vector3(hs,hs,hs),new THREE.Vector3(-hs,hs,hs)];
      const edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
      for(const [a,b] of edges){
        for(let j=0;j<N;j++){
          const p=new THREE.Vector3().lerpVectors(verts[a], verts[b], j/N);
          splats.pushSplat(p, scales, q, 1, col);
        }
      }
    }
  });
  return mesh;
}
function addCameraFromCurrent(){
  if(!fixFovDone){
    toast("Сначала нажми «Зафиксировать камеру»");
    return;
  }
  const fov = parseInt($("#fov").value);
  const res = $("#resolution").value;
  const asp = parseInt(res.split("x")[2]) / parseInt(res.split("x")[1]);
  const cam = new THREE.PerspectiveCamera(fov, asp);
  cam.position.copy(camera.position);
  cam.quaternion.copy(camera.quaternion);
  cam.updateProjectionMatrix();
  const splat = createCameraSplat(cam);
  cameraSplats.push(splat);
  cameraParams.push({ position: cam.position.clone(), quaternion: cam.quaternion.clone(), fov: cam.fov, aspect: cam.aspect });
  scene.add(splat);
  renderCamList();
  updateCamCount();
  setStatus(`Камера ${cameraParams.length} записана`, "камеры");
}
function renderCamList(){
  const list=$("#cam-list");
  list.innerHTML="";
  cameraParams.forEach((c,i)=>{
    const div=document.createElement("div");
    div.className="cam-item";
    div.innerHTML=`<div class="step-num" style="width:20px;height:20px;font-size:11px">${i+1}</div><div><b>Камера ${i+1}</b><br><small>${c.position.x.toFixed(2)}, ${c.position.y.toFixed(2)}, ${c.position.z.toFixed(2)} • fov ${c.fov.toFixed(0)}°</small></div><div class="cam-actions"><button class="icon-btn" title="Просмотр">👁️</button><button class="icon-btn" title="Удалить">🗑️</button></div>`;
    const [btnView, btnDel] = div.querySelectorAll(".icon-btn");
    btnView.onclick=()=>{
      camera.position.copy(c.position);
      camera.quaternion.copy(c.quaternion);
      camera.fov = c.fov; camera.updateProjectionMatrix();
    };
    btnDel.onclick=()=>{
      if(cameraParams.length<=1){ toast("Оставь хотя бы одну камеру"); return;}
      const splat = cameraSplats[i];
      scene.remove(splat);
      cameraSplats.splice(i,1);
      cameraParams.splice(i,1);
      renderCamList(); updateCamCount();
      clearInterp();
    };
    list.appendChild(div);
  });
}
function clearInterp(){
  interpSplats.forEach(s=>scene.remove(s));
  interpSplats.length=0;
}
function interpolateCameras(cams, M){
  const out=[];
  if(cams.length===0) return out;
  if(cams.length===1){ for(let i=0;i<M;i++) out.push(cams[0]); return out; }
  for(let i=0;i<M;i++){
    const t=i/(M-1);
    const si=Math.min(Math.floor(t*(cams.length-1)), cams.length-2);
    const ei=si+1;
    const tt=t*(cams.length-1)-si;
    const a=cams[si], b=cams[ei];
    const cam=new THREE.PerspectiveCamera(a.fov, a.aspect);
    cam.position.copy(a.position).lerp(b.position, tt);
    cam.quaternion.copy(a.quaternion).slerp(b.quaternion, tt);
    cam.fov = a.fov*(1-tt)+b.fov*tt;
    cam.aspect = a.aspect;
    out.push(cam);
  }
  return out;
}
function visibleToggle(){
  const v1=$("#chk-vis-cams").checked, v2=$("#chk-vis-interp").checked;
  cameraSplats.forEach(s=>s.opacity = v1?1:0);
  interpSplats.forEach(s=>s.opacity = v2?1:0);
}
function scrubTo(pct){
  if(cameraParams.length<2) return;
  const t=pct/100;
  const cams=interpolateCameras(cameraParams, 100);
  const idx=Math.min(Math.floor(t*(cams.length-1)), cams.length-1);
  const c=cams[idx];
  camera.position.copy(c.position);
  camera.quaternion.copy(c.quaternion);
  camera.fov=c.fov; camera.updateProjectionMatrix();
}

// ---------- Template trajectory ----------
function generateTrajectory(type){
  if(!fixFovDone){ toast("Сначала зафиксируй камеру"); return; }
  let refCam;
  if(cameraParams.length>0){
    const last=cameraParams[cameraParams.length-1];
    refCam=new THREE.PerspectiveCamera(last.fov, camera.aspect);
    refCam.position.copy(last.position); refCam.quaternion.copy(last.quaternion);
  } else {
    refCam=new THREE.PerspectiveCamera(parseInt($("#fov").value), camera.aspect);
    refCam.position.set(0,0,0); refCam.quaternion.set(0,0,0,1);
  }
  const step=0.5;
  const totalAngle=15*Math.PI/180;
  let orbitTarget=null, orbitStart=null;
  if(type.includes("Orbit")){
    if(cameraParams.length>0){
      orbitStart=cameraParams[cameraParams.length-1];
      orbitTarget=orbitStart.position.clone().add(new THREE.Vector3(0,0,-1).applyQuaternion(orbitStart.quaternion));
    } else {
      orbitStart=refCam; orbitTarget=refCam.position.clone().add(new THREE.Vector3(0,0,-1).applyQuaternion(refCam.quaternion));
    }
  }
  const newCams=[];
  const mk=(pos, quat)=>{
    const cam=new THREE.PerspectiveCamera(parseInt($("#fov").value), camera.aspect);
    cam.position.copy(pos); cam.quaternion.copy(quat); return cam;
  };
  if(type==="Move Forward"){
    newCams.push(mk(refCam.position.clone().add(new THREE.Vector3(0,0,-step)), refCam.quaternion.clone()));
  } else if(type==="Move Backward"){
    newCams.push(mk(refCam.position.clone().add(new THREE.Vector3(0,0,step)), refCam.quaternion.clone()));
  } else if(type==="Move Left"){
    newCams.push(mk(refCam.position.clone().add(new THREE.Vector3(-step,0,0)), refCam.quaternion.clone()));
  } else if(type==="Move Right"){
    newCams.push(mk(refCam.position.clone().add(new THREE.Vector3(step,0,0)), refCam.quaternion.clone()));
  } else if(type==="Orbit Left 15°"){
    const radius=1.0, angle=-totalAngle;
    const local=new THREE.Vector3(Math.sin(angle)*radius,0,Math.cos(angle)*radius);
    const world=local.clone().applyQuaternion(orbitStart.quaternion);
    const pos=orbitTarget.clone().add(world);
    const dir=orbitTarget.clone().sub(pos).normalize();
    const quat=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), dir);
    newCams.push(mk(pos, quat));
  } else if(type==="Orbit Right 15°"){
    const radius=1.0, angle=totalAngle;
    const local=new THREE.Vector3(Math.sin(angle)*radius,0,Math.cos(angle)*radius);
    const world=local.clone().applyQuaternion(orbitStart.quaternion);
    const pos=orbitTarget.clone().add(world);
    const dir=orbitTarget.clone().sub(pos).normalize();
    const quat=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1), dir);
    newCams.push(mk(pos, quat));
  }
  newCams.forEach(cam=>{
    const splat=createCameraSplat(cam);
    cameraSplats.push(splat); cameraParams.push({position:cam.position.clone(), quaternion:cam.quaternion.clone(), fov:cam.fov, aspect:cam.aspect});
    scene.add(splat);
  });
  renderCamList(); updateCamCount();
  setStatus(`Добавлено ${newCams.length} камер: ${type}`, "камеры");
}

// ---------- File handling ----------
function handleImageFile(file){
  if(!file) return;
  if(file.size>10*1024*1024){ toast("Файл слишком большой (>10MB)"); return; }
  const reader=new FileReader();
  reader.onload=(e)=>{
    const dataUrl=e.target.result;
    // need to crop to resolution
    const img=new Image();
    img.onload=()=>{
      imageResolution={width:img.width,height:img.height};
      const res=$("#resolution").value;
      const [n,H,W]=res.split("x").map(Number);
      // center crop logic similar to app.py
      let scale = Math.max(H/img.height, W/img.width);
      let newW=Math.round(W/scale), newH=Math.round(H/scale);
      let sx=Math.floor((img.width-newW)/2), sy=Math.floor((img.height-newH)/2);
      const canvas=document.createElement("canvas");
      canvas.width=W; canvas.height=H;
      const ctx=canvas.getContext("2d");
      ctx.drawImage(img, sx,sy,newW,newH, 0,0,W,H);
      imageBase64=canvas.toDataURL("image/png");
      // preview show cropped version
      $("#preview-img").src=imageBase64;
      $("#preview-name").textContent=file.name;
      $("#preview-size").textContent=`${W}×${H} • ${(file.size/1024).toFixed(0)}KB→кроп`;
      $("#preview").style.display="block";
      $("#image-status").textContent="фото загружено";
      $("#image-status").style.background="rgba(34,197,94,0.18)";
      $("#image-status").style.borderColor="rgba(34,197,94,0.3)";
      // store for backend fy calculation
      imageResolution={width:W,height:H};
      toast("Фото загружено и кропнуто");
    };
    img.src=dataUrl;
  };
  reader.readAsDataURL(file);
}

// ---------- JSON load/save ----------
let loadTrajectoryOnly=false;
function processJsonLoad(data, onlyTraj){
  // clear
  cameraSplats.forEach(s=>scene.remove(s)); cameraSplats.length=0; cameraParams.length=0;
  interpSplats.forEach(s=>scene.remove(s)); interpSplats.length=0;

  const imagePrompt=data.image_prompt||data.imagePrompt||null;
  const textPrompt=data.text_prompt||data.textPrompt||"";
  const cameras=data.cameras||[];
  const resolution=data.resolution||[16,480,704];
  const imageIndex=data.image_index||data.imageIndex||0;

  if(!onlyTraj && imagePrompt){
    imageBase64=imagePrompt;
    $("#preview-img").src=imageBase64;
    $("#preview").style.display="block";
    $("#preview-name").textContent="из JSON";
    $("#image-status").textContent="фото из JSON";
  }
  if(!onlyTraj){
    $("#text-prompt").value=textPrompt;
    $("#image-index").value=imageIndex;
    $("#image-index-out").textContent=imageIndex;
  }
  if(!onlyTraj && Array.isArray(resolution) && resolution.length===3 && cameras.length>0){
    const H=resolution[1];
    const first=cameras[0];
    if(first && typeof first.fy==="number" && first.fy>0){
      const fov=2*Math.atan(0.5*H/first.fy)*180/Math.PI;
      $("#fov").value=Math.round(fov);
      $("#fov-out").textContent=Math.round(fov)+"°";
      syncCanvasSize();
    }
  }
  if(cameras.length>0){
    let firstPos=null, firstQuat=null;
    const first=cameras[0];
    if(Array.isArray(first?.position)) firstPos=new THREE.Vector3(first.position[0],first.position[1],first.position[2]);
    if(Array.isArray(first?.quaternion)) firstQuat=new THREE.Quaternion(first.quaternion[1],first.quaternion[2],first.quaternion[3],first.quaternion[0]);
    cameras.forEach(cd=>{
      let aspect=1;
      if(Array.isArray(resolution) && resolution.length===3) aspect=resolution[2]/resolution[1];
      else aspect=parseInt($("#resolution").value.split("x")[2])/parseInt($("#resolution").value.split("x")[1]);
      let fov=60;
      if(onlyTraj) fov=parseInt($("#fov").value);
      else if(Array.isArray(resolution) && typeof cd.fy==="number" && cd.fy>0){ const H=resolution[1]; fov=2*Math.atan(0.5*H/cd.fy)*180/Math.PI; }
      else fov=parseInt($("#fov").value);
      const cam=new THREE.PerspectiveCamera(fov, aspect);
      if(Array.isArray(cd.position)) cam.position.set(cd.position[0],cd.position[1],cd.position[2]);
      if(Array.isArray(cd.quaternion)) cam.quaternion.set(cd.quaternion[1],cd.quaternion[2],cd.quaternion[3],cd.quaternion[0]);
      if(firstPos && firstQuat){
        const firstC2W=new THREE.Matrix4().compose(firstPos, firstQuat, new THREE.Vector3(1,1,1));
        const curC2W=new THREE.Matrix4().compose(cam.position, cam.quaternion, new THREE.Vector3(1,1,1));
        const refW2C=firstC2W.clone().invert();
        const rel=refW2C.clone().multiply(curC2W);
        const fixed=new THREE.Matrix4().compose(new THREE.Vector3(0,0,0), new THREE.Quaternion(0,0,0,1), new THREE.Vector3(1,1,1));
        const nt=fixed.clone().multiply(rel);
        const np=new THREE.Vector3(), nq=new THREE.Quaternion(), ns=new THREE.Vector3();
        nt.decompose(np,nq,ns);
        cam.position.copy(np); cam.quaternion.copy(nq);
      }
      cam.fov=fov; cam.aspect=aspect; cam.updateProjectionMatrix();
      const splat=createCameraSplat(cam);
      cameraSplats.push(splat); cameraParams.push({position:cam.position.clone(), quaternion:cam.quaternion.clone(), fov:cam.fov, aspect:cam.aspect});
      scene.add(splat);
    });
  }
  if(!onlyTraj && Array.isArray(resolution) && resolution.length===3){
    $("#resolution").value=`${resolution[0]}x${resolution[1]}x${resolution[2]}`;
    syncCanvasSize();
  }
  renderCamList(); updateCamCount();
  setStatus(`JSON загружен: ${cameras.length} камер`, "готов");
}

// ---------- Generate ----------
async function doGenerate(){
  if(cameraParams.length<2){ toast("Нужно минимум 2 камеры! Нажми Space или выбери шаблон."); return; }
  const textPrompt=$("#text-prompt").value.trim();
  if(!imageBase64 && !textPrompt){ toast("Добавь фото или текст!"); return; }

  if(currentSplat){ scene.remove(currentSplat); currentSplat=null; }
  // show progress
  showProgress(true, "Генерация сцены...", 0, "Отправка на бэкенд...");
  $("#btn-generate").disabled=true;
  $("#viewer-empty").style.display="none";

  // create interpolated cameras for payload
  const resVal=$("#resolution").value;
  const [n,H,W]=resVal.split("x").map(Number);
  const fovDeg=parseInt($("#fov").value);
  const fy=0.5/Math.tan(0.5*fovDeg*Math.PI/180)*H;
  const fx=fy;
  const cx= imageBase64 && imageResolution ? 0.5*imageResolution.width : 0.5*W;
  const cy= imageBase64 && imageResolution ? 0.5*imageResolution.height : 0.5*H;

  // interpolate to n frames
  const interp = interpolateCameras(cameraParams, n);
  // visualize interp
  clearInterp();
  interp.forEach(cam=>{
    const s=createCameraSplat(cam, [0.6,0.6,0.6]);
    interpSplats.push(s); scene.add(s);
  });
  visibleToggle();

  const payload={
    image_prompt: imageBase64 || null,
    text_prompt: textPrompt,
    image_index: parseInt($("#image-index").value) || 0,
    resolution: [n,H,W],
    cameras: interp.map(cam=>({
      position:[cam.position.x, cam.position.y, cam.position.z],
      quaternion:[cam.quaternion.w, cam.quaternion.x, cam.quaternion.y, cam.quaternion.z],
      fx, fy, cx, cy
    }))
  };

  const base=apiBase();
  try{
    const resp=await fetchWithAuth(base+"/api/generate", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    if(!resp.ok) throw new Error("Backend error "+resp.status+" "+await resp.text());
    const j=await resp.json();
    currentTaskId=j.task_id;
    setStatus("В очереди...","выполнение");
    pollTask();
  }catch(e){
    console.error(e);
    showProgress(false);
    $("#btn-generate").disabled=false;
    setStatus("Ошибка: "+e.message,"ошибка");
    alert("Ошибка генерации: "+e.message);
  }
}
async function pollTask(){
  if(!currentTaskId) return;
  const base=apiBase();
  try{
    const r=await fetchWithAuth(base+`/api/tasks/${currentTaskId}`);
    if(!r.ok) throw new Error("poll failed "+r.status);
    const info=await r.json();
    $("#progress-bar").style.width=info.progress+"%";
    $("#progress-text").textContent=`${info.progress}% • ${info.message}`;
    $("#progress-msg").textContent=info.message;
    $("#badge-queue").textContent=`прогресс ${info.progress}%`;
    $("#badge-time").textContent=info.status;

    if(info.status==="completed" && info.download_url){
      // download file progress
      $("#progress-text").textContent=`100% • Загрузка...`;
      $("#progress-msg").textContent=`Размер: ${(info.file_size/1024/1024).toFixed(2)} MB • время ${info.generation_time?.toFixed(1)}с`;
      $("#stat-size").textContent=(info.file_size/1024/1024).toFixed(2)+" MB";
      $("#stat-time").textContent=(info.generation_time||0).toFixed(1)+"с";

      // fetch SPZ with progress
      const dlUrl = base + info.download_url;
      const resp = await fetchWithAuth(dlUrl);
      if(!resp.ok) throw new Error("download failed "+resp.status);
      const total = parseInt(resp.headers.get("content-length")||"0",10);
      const reader = resp.body.getReader();
      const chunks=[];
      let loaded=0;
      while(true){
        const {done,value}=await reader.read();
        if(done) break;
        chunks.push(value); loaded+=value.length;
        if(total){
          const pct=Math.min(100, loaded/total*100);
          $("#progress-bar").style.width=pct+"%";
          $("#progress-text").textContent=`Загрузка ${Math.round(pct)}%`;
        }
      }
      const blob=new Blob(chunks);
      const url=URL.createObjectURL(blob);
      // load splat
      if(instructionSplat){ scene.remove(instructionSplat); instructionSplat=null; }
      $("#viewer-empty").style.display="none";
      const splat=new SplatMesh({url});
      scene.add(splat);
      currentSplat=splat;
      showProgress(false);
      $("#btn-generate").disabled=false;
      $("#btn-download-spz").disabled=false;
      $("#btn-download-spz").onclick=()=>{
        const a=document.createElement("a"); a.href=url; a.download=`scene-${currentTaskId}.spz`; a.click();
      };
      setStatus("Готово! Сцена загружена","готово");
      // notify delete after 5s
      try{ await fetchWithAuth(base+`/api/delete/${currentTaskId}`, {method:"POST"}); }catch{}
      clearInterval(pollTimer); pollTimer=null;
      currentTaskId=null;
      return;
    }
    if(info.status==="failed"){
      showProgress(false);
      $("#btn-generate").disabled=false;
      setStatus("Ошибка: "+(info.error||"unknown"),"ошибка");
      alert("Генерация не удалась: "+info.error);
      clearInterval(pollTimer); pollTimer=null;
      return;
    }
    // continue polling
    if(!pollTimer) pollTimer=setInterval(pollTask, 1500);
  }catch(e){
    console.error("poll error", e);
    // retry
    if(!pollTimer) pollTimer=setInterval(pollTask, 2000);
  }
}

// ---------- Examples ----------
async function loadExamples(){
  const base=apiBase();
  try{
    const r=await fetch(base+"/api/examples");
    const j=await r.json();
    const grid=$("#examples-grid");
    grid.innerHTML="";
    j.examples.slice(0,8).forEach(ex=>{
      const div=document.createElement("div");
      div.className="gal-item";
      div.title=ex.text_prompt||ex.id;
      const img=document.createElement("img");
      img.src=ex.image_prompt || "data:image/svg+xml,"+encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='100%' height='100%' fill='#1e1e2e'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#94a3b8' font-size='12'>no image</text></svg>`);
      div.appendChild(img);
      const cap=document.createElement("div");
      cap.className="cap";
      cap.textContent=ex.text_prompt ? ex.text_prompt.slice(0,80) : `Пример ${ex.id}`;
      div.appendChild(cap);
      div.onclick=async()=>{
        if(ex.image_prompt && ex.image_prompt.startsWith("data:")){
          // direct use
          const data={image_prompt:ex.image_prompt, text_prompt:ex.text_prompt, cameras:[], resolution:ex.resolution, image_index:0};
          // Need full cameras: fetch json
          const jr=await fetch(base+`/api/examples/${ex.id}/json`);
          const full=await jr.json();
          processJsonLoad(full,false);
        } else {
          const jr=await fetch(base+`/api/examples/${ex.id}/json`);
          const full=await jr.json();
          processJsonLoad(full,false);
        }
      };
      grid.appendChild(div);
    });
  }catch(e){ console.error("examples load failed", e); }
}

// ---------- Init ----------
let fixFovDone=false;
function initEvents(){
  // Init renderer first
  initRenderer();

  // cube
  instructionSplat=createCubeSplat(0.24,[0.9,0.9,1]);
  instructionSplat.position.set(0,0,-1.1);
  scene.add(instructionSplat);
  updateCamCount();

  // FOV slider
  $("#fov").oninput=(e)=>{ $("#fov-out").textContent=e.target.value+"°"; camera.fov=parseInt(e.target.value); camera.updateProjectionMatrix(); $("#stat-fov").textContent=e.target.value+"°"; };
  $("#resolution").onchange=syncCanvasSize;
  $("#image-index").oninput=(e)=>$("#image-index-out").textContent=e.target.value;
  $("#scrub").oninput=(e)=>{ $("#scrub-out").textContent=e.target.value+"%"; scrubTo(parseInt(e.target.value)); };
  $("#chk-vis-cams").onchange=visibleToggle;
  $("#chk-vis-interp").onchange=visibleToggle;

  // dropzone
  const dz=$("#dropzone");
  dz.addEventListener("dragover",(e)=>{e.preventDefault();dz.classList.add("drag")});
  dz.addEventListener("dragleave",()=>dz.classList.remove("drag"));
  dz.addEventListener("drop",(e)=>{
    e.preventDefault(); dz.classList.remove("drag");
    const f=e.dataTransfer.files[0]; if(f) handleImageFile(f);
  });
  $("#file-input").onchange=(e)=>{ const f=e.target.files[0]; if(f) handleImageFile(f); e.target.value=""; };
  $("#btn-remove-image").onclick=()=>{
    imageBase64=null; imageResolution=null;
    $("#preview").style.display="none"; $("#image-status").textContent="нет фото";
    $("#image-status").style.background=""; $("#image-status").style.borderColor="";
  };

  // trajectory mode
  $("#trajectory-mode").onchange=(e)=>{
    const v=e.target.value;
    const isTemplate=v==="template", isJson=v==="json";
    $("#template-type").disabled=!isTemplate;
    $("#btn-gen-traj").disabled=!isTemplate;
    $("#btn-load-traj").disabled=!isJson;
    if(!fixFovDone && (isTemplate||isJson)){ toast("Сначала зафиксируй камеру"); }
  };
  // ensure initial disabled
  $("#template-type").disabled=true; $("#btn-gen-traj").disabled=true; $("#btn-load-traj").disabled=true;

  $("#btn-fix").onclick=()=>{
    fixFovDone=true;
    const fov=parseInt($("#fov").value);
    const res=$("#resolution").value;
    const asp=parseInt(res.split("x")[2])/parseInt(res.split("x")[1]);
    const cam=new THREE.PerspectiveCamera(fov, asp);
    cam.position.set(0,0,0); cam.quaternion.set(0,0,0,1); cam.updateProjectionMatrix();
    const splat=createCameraSplat(cam);
    cameraSplats.push(splat); cameraParams.push({position:cam.position.clone(), quaternion:cam.quaternion.clone(), fov:cam.fov, aspect:cam.aspect});
    scene.add(splat);
    $("#btn-fix").disabled=true;
    // enable controls depending on mode
    const mode=$("#trajectory-mode").value;
    if(mode==="template"){ $("#template-type").disabled=false; $("#btn-gen-traj").disabled=false; }
    if(mode==="json"){ $("#btn-load-traj").disabled=false; }
    renderCamList(); updateCamCount();
    setStatus("Камера зафиксирована. Добавь ещё камеры.", "камеры");
  };
  $("#btn-gen-traj").onclick=()=>{
    const t=$("#template-type").value;
    generateTrajectory(t);
  };
  $("#btn-load-traj").onclick=()=>{ loadTrajectoryOnly=true; $("#json-input").click(); };
  $("#btn-save-traj").onclick=()=>{
    if(cameraParams.length<2){ toast("Нужно минимум 2 камеры"); return; }
    const payload={cameras: cameraParams.map(c=>({position:[c.position.x,c.position.y,c.position.z], quaternion:[c.quaternion.w,c.quaternion.x,c.quaternion.y,c.quaternion.z]}))};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`trajectory_${Date.now()}.json`; a.click();
  };
  $("#btn-clear-cams").onclick=()=>{
    if(cameraParams.length<=1){ toast("Нечего очищать"); return; }
    for(let i=cameraSplats.length-1;i>=1;i--){ scene.remove(cameraSplats[i]); }
    cameraSplats.splice(1); cameraParams.splice(1);
    clearInterp(); renderCamList(); updateCamCount();
    setStatus("Очищено, оставлена 1 камера","камеры");
  };
  $("#btn-save-all").onclick=()=>{
    const [n,H,W]=$("#resolution").value.split("x").map(Number);
    const fov=parseInt($("#fov").value);
    const fy=0.5/Math.tan(0.5*fov*Math.PI/180)*H, fx=fy, cx=0.5*W, cy=0.5*H;
    const payload={
      image_prompt: imageBase64,
      text_prompt: $("#text-prompt").value,
      image_index: parseInt($("#image-index").value)||0,
      resolution:[n,H,W],
      cameras: cameraParams.map(c=>({position:[c.position.x,c.position.y,c.position.z], quaternion:[c.quaternion.w,c.quaternion.x,c.quaternion.y,c.quaternion.z], fx,fy,cx,cy}))
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`scene_all_${Date.now()}.json`; a.click();
  };
  $("#json-input").onchange=(e)=>{
    const f=e.target.files[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const data=JSON.parse(r.result);
        processJsonLoad(data, loadTrajectoryOnly);
      }catch(err){ alert("Ошибка JSON: "+err); }
      loadTrajectoryOnly=false;
    };
    r.readAsText(f); e.target.value="";
  };

  // generate
  $("#btn-generate").onclick=doGenerate;
  $("#btn-cancel").onclick=()=>{
    if(currentTaskId){
      // just hide overlay, backend will still finish; we could call delete
      showProgress(false);
      $("#btn-generate").disabled=false;
      setStatus("Отменено","ожидание");
      clearInterval(pollTimer); pollTimer=null;
      const base=apiBase();
      fetchWithAuth(base+`/api/delete/${currentTaskId}`, {method:"POST"}).catch(()=>{});
      currentTaskId=null;
    }
  };

  // space to record
  document.addEventListener("keypress",(e)=>{
    if(e.code==="Space"){
      if(!fixFovDone){ toast("Сначала зафиксируй камеру"); return; }
      e.preventDefault();
      addCameraFromCurrent();
    }
  });

  // viewer controls
  $("#btn-reset-view").onclick=()=>{
    camera.position.set(0,0,1.6); camera.quaternion.set(0,0,0,1); camera.fov=parseInt($("#fov").value); camera.updateProjectionMatrix();
  };
  $("#btn-fullscreen").onclick=()=>{
    if(document.fullscreenElement) document.exitFullscreen();
    else canvasWrap.requestFullscreen();
  };
  $("#btn-demo-scene").onclick=()=>{
    // show demo: add a quick fake scene via cube + extra splats
    if(currentSplat) scene.remove(currentSplat);
    // Create a quick demo spz-like visual: use additional cube splats
    const demo = createCubeSplat(1.0, [0.7,0.8,1]);
    demo.position.set(0,0,-1.5);
    scene.add(demo);
    currentSplat=demo;
    $("#viewer-empty").style.display="none";
    setStatus("Демо-сцена показана (без генерации)","демо");
    setTimeout(()=>{ scene.remove(demo); if(currentSplat===demo) currentSplat=null; }, 3000);
  };
  $("#btn-download-json").onclick=()=>$("#btn-save-all").click();
  $("#btn-copy-link").onclick=async()=>{
    await navigator.clipboard.writeText(location.href);
    toast("Ссылка скопирована");
  };
  $("#btn-share").onclick=async()=>{
    if(navigator.share) await navigator.share({title:"FlashWorld", text:"Моя 3D сцена", url:location.href});
    else{
      await navigator.clipboard.writeText(location.href);
      toast("Ссылка скопирована");
    }
  };

  // dialogs
  $("#btn-how").onclick=()=>$("#dialog-how").classList.add("show");
  $("#btn-close-how").onclick=()=>$("#dialog-how").classList.remove("show");
  $("#dialog-how").onclick=(e)=>{ if(e.target.id==="dialog-how") e.currentTarget.classList.remove("show"); };

  // api links
  $("#link-api").onclick=(e)=>{ e.preventDefault(); const b=apiBase()||location.origin; window.open(b+"/api/examples","_blank"); };
  $("#link-health").onclick=(e)=>{ e.preventDefault(); const b=apiBase()||location.origin; window.open(b+"/api/health","_blank"); };

  // backend url autosave
  const saved=localStorage.getItem("fw_backend");
  if(saved) $("#backend-url").value=saved;
  $("#backend-url").onchange=(e)=>localStorage.setItem("fw_backend", e.target.value.trim());
  $("#hf-token").value=localStorage.getItem("fw_hf")||"";
  $("#hf-token").onchange=(e)=>localStorage.setItem("fw_hf", e.target.value);

  window.addEventListener("resize", syncCanvasSize);
}

// ---------- Render loop ----------
function animate(time){
  const dt=time - (animate.last||time); animate.last=time;
  if(instructionSplat && !currentSplat){
    instructionSplat.rotation.y += dt/4000;
    instructionSplat.rotation.z += dt/5000;
  }
  if(controls) controls.update(camera);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ---------- Boot ----------
initEvents();
loadExamples();
requestAnimationFrame(animate);
setStatus("Готов к работе","ожидание");
console.log("[FlashWorld Site] ready");
