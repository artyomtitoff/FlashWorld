"""
FlashWorld Site Backend — FastAPI server for photo-to-3D generation
- Demo mode (no GPU/checkpoint) simulates generation with mock SPZ playback
- Production mode wraps GenerationSystem when available
"""
import os
import io
import json
import time
import uuid
import shutil
import base64
import asyncio
import threading
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks, Request
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------- Config ----------
ROOT = Path(__file__).parent.parent
FRONTEND_DIR = ROOT / "frontend"
CACHE_DIR = Path(os.environ.get("FLASHWORLD_CACHE", "/tmp/flashworld_site"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
EXAMPLES_DIR = ROOT.parent / "examples"
# In the deployed site structure frontend is at same level, but when running from repo root also check
if not EXAMPLES_DIR.exists():
    EXAMPLES_DIR = Path.cwd() / "examples"
if not EXAMPLES_DIR.exists():
    EXAMPLES_DIR = ROOT.parent.parent / "examples" if (ROOT.parent.parent / "examples").exists() else EXAMPLES_DIR

DEMO_MODE = os.environ.get("FLASHWORLD_DEMO", "1") == "1"  # default demo for preview
MOCK_GENERATION_SECONDS = 8

print(f"[FlashWorld Site] DEMO_MODE={DEMO_MODE} CACHE_DIR={CACHE_DIR} EXAMPLES={EXAMPLES_DIR}")

# Try to load real GenerationSystem if not in demo and GPU available
generation_system = None
if not DEMO_MODE:
    try:
        import torch
        from app import GenerationSystem  # type: ignore
        ckpt = os.environ.get("FLASHWORLD_CKPT")
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        generation_system = GenerationSystem(ckpt_path=ckpt, device=str(device))
        print(f"[FlashWorld Site] Real GenerationSystem loaded on {device}")
    except Exception as e:
        print(f"[FlashWorld Site] Failed to load real model, falling back to DEMO: {e}")
        DEMO_MODE = True

# ---------- In-memory task store ----------
tasks: Dict[str, Dict[str, Any]] = {}
tasks_lock = threading.Lock()

class GenerateRequest(BaseModel):
    image_prompt: Optional[str] = None  # base64 data url or null
    text_prompt: str = ""
    cameras: List[Dict[str, Any]]
    resolution: List[int]  # [n_frame, H, W]
    image_index: int = 0
    backend_options: Optional[Dict[str, Any]] = None

class TaskStatus(BaseModel):
    task_id: str
    status: str
    progress: int
    message: str
    download_url: Optional[str] = None
    generation_time: Optional[float] = None
    file_size: Optional[int] = None
    error: Optional[str] = None

def create_task_id():
    return uuid.uuid4().hex[:12]

def cleanup_old_tasks(max_age_sec=30*60):
    while True:
        time.sleep(300)
        now = time.time()
        with tasks_lock:
            to_del = []
            for tid, t in tasks.items():
                if now - t.get("created_at", now) > max_age_sec:
                    to_del.append(tid)
            for tid in to_del:
                # remove files
                for ext in (".spz", ".json", ".mp4", ".ply"):
                    p = CACHE_DIR / f"{tid}{ext}"
                    if p.exists():
                        try: p.unlink()
                        except: pass
                tasks.pop(tid, None)
threading.Thread(target=cleanup_old_tasks, daemon=True).start()

# ---------- FastAPI app ----------
app = FastAPI(title="FlashWorld Site API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Helpers ----------
def save_base64_image(data_url: str, dest: Path):
    try:
        if "," in data_url:
            b64 = data_url.split(",", 1)[1]
        else:
            b64 = data_url
        # handle urlsafe or regular
        b64 += "=" * (-len(b64) % 4)
        img_bytes = base64.b64decode(b64)
        dest.write_bytes(img_bytes)
        return True
    except Exception as e:
        print(f"save_base64 failed: {e}")
        return False

def mock_generate_task(task_id: str, data: dict):
    """Simulate generation progress and create mock artifact"""
    with tasks_lock:
        tasks[task_id]["status"] = "running"
        tasks[task_id]["progress"] = 5
        tasks[task_id]["message"] = "Подготовка сцены..."

    steps = [
        (15, "Анализ изображения..."),
        (30, "Кодирование геометрии..."),
        (50, "Генерация 3D гауссиан (Diffusion)..."),
        (70, "Реконструкция сцены..."),
        (85, "Оптимизация SPZ..."),
        (95, "Финализация..."),
    ]
    for pct, msg in steps:
        time.sleep(MOCK_GENERATION_SECONDS / len(steps) * 0.8)
        with tasks_lock:
            if tasks[task_id]["status"] == "cancelled":
                return
            tasks[task_id]["progress"] = pct
            tasks[task_id]["message"] = msg

    # Create a mock .spz file by copying a sample if exists, or create tiny placeholder
    # We will reuse one of example images' SPZ if we had generated; for demo we just create a tiny JSON placeholder
    # But for spark viewer we need a real SPZ. We'll generate a minimal valid SPZ-like file?
    # Instead we can provide a pre-bundled demo SPZ asset. We'll create a small one from scratch using spz lib if available,
    # else return a placeholder and frontend will show demo viewer with synthetic point cloud.

    out_spz = CACHE_DIR / f"{task_id}.spz"
    out_json = CACHE_DIR / f"{task_id}.json"
    # save request json
    out_json.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # Try to create a minimal PLY/SPZ using pure python (plyfile) — works without spz binary
    # We generate a synthetic Gaussian PLY that Spark can load as splat
    # Fallback uses spz lib if available, else ply
    def create_ply_gaussian(path: Path, data: dict):
        import numpy as np
        from plyfile import PlyData, PlyElement
        N = 6000
        seed = abs(hash((data.get("text_prompt","") + str(data.get("resolution"))))) % 100000
        rng = np.random.default_rng(seed)
        # positions
        xyz = rng.normal(0, 0.5, (N,3)).astype(np.float32)
        xyz[:,2] -= 1.0
        xyz[:,1] -= 0.15
        # color palette from text hash
        base_hue = (seed % 360)/360.0
        colors = rng.uniform(0.3, 1.0, (N,3)).astype(np.float32)
        # simple hue shift
        # opacity before inverse sigmoid ~0.1 ->  -2.2 ; we store log(opacity/(1-opacity)) but for PLY we store raw logit
        opacities_logit = np.full(N, 0.8, dtype=np.float32)  # sigmoid(0.8)=0.69
        scales_log = np.full((N,3), -2.3, dtype=np.float32)  # log scale
        rotations = np.tile(np.array([0,0,0,1], dtype=np.float32), (N,1))  # w,x,y,z
        # SH: degree 1 needs 9 coeffs per color? For ply we need f_dc_0..8
        # We'll create 3 DC + 3*? sh coefficients: for degree 0 =3, degree1=12?
        # Mimic sh_degree=1 => (1+1)^2*3=12 features
        sh_degree = 1
        sh_dim = (sh_degree+1)**2 * 3
        # features: first 3 = DC, rest zero
        f_dc = np.zeros((N, sh_dim), dtype=np.float32)
        f_dc[:,:3] = (colors - 0.5) / 0.2820947917  # inverse SH DC approx (from original code: colors are base RGB)
        # Build ply element
        # attributes: x,y,z, f_dc_*, opacity, scale_*, rot_*
        l = ['x','y','z']
        for i in range(f_dc.shape[1]):
            l.append(f'f_dc_{i}')
        l.append('opacity')
        for i in range(3):
            l.append(f'scale_{i}')
        for i in range(4):
            l.append(f'rot_{i}')
        dtype_full = [(a,'f4') for a in l]
        # stack attributes as float32
        attrs = np.concatenate([xyz, f_dc, opacities_logit[:,None], scales_log, rotations], axis=1)
        # recarray
        elements = np.empty(N, dtype=dtype_full)
        for i, name in enumerate(l):
            elements[name] = attrs[:,i]
        el = PlyElement.describe(elements, 'vertex')
        PlyData([el]).write(str(path))
        print(f"Mock PLY created {path} with {N} gaussians")

    # Also try SPZ if available
    made = False
    try:
        import spz  # type: ignore
        import numpy as np
        N = 8000
        seed = abs(hash(data.get("text_prompt","") + str(data.get("resolution")))) % 10000
        rng = np.random.default_rng(seed)
        xyz = rng.normal(0, 0.6, (N,3)).astype(np.float32)
        xyz[:,2] -= 1.0
        xyz[:,1] -= 0.2
        colors = rng.uniform(0.2, 1.0, (N,3)).astype(np.float32)
        opacities = np.full(N, 2.0, dtype=np.float32)
        scales = np.full((N,3), -2.5, dtype=np.float32)
        rotations = np.tile(np.array([0,0,0,1], dtype=np.float32), (N,1))
        sh = np.zeros((N, 9), dtype=np.float32)
        cloud = spz.GaussianCloud()
        cloud.sh_degree = 1
        cloud.positions = xyz.flatten()
        cloud.scales = scales.flatten()
        cloud.rotations = rotations[:, [1,2,3,0]].flatten()
        cloud.alphas = opacities.flatten()
        cloud.colors = colors.flatten()
        cloud.sh = sh.flatten()
        spz.save_spz(cloud, spz.PackOptions(), str(out_spz))
        print(f"Mock SPZ created {out_spz} size {out_spz.stat().st_size}")
        made = True
    except Exception as e:
        print(f"spz creation failed {e}, trying PLY fallback")

    if not made:
        try:
            # create ply and also spz-named file as ply (spark can load ply via url with .ply extension)
            # We'll create both .ply and .spz (as ply content but with ply extension the viewer will handle)
            ply_path = CACHE_DIR / f"{task_id}.ply"
            create_ply_gaussian(ply_path, data)
            # also copy ply to spz path for compatibility (serve as ply but named spz -> frontend will fetch correct endpoint)
            # Actually frontend fetches /api/download/{id} which returns spz; we will make it serve ply if spz missing
            # So we copy ply to spz path as placeholder bytes with ply header (still readable if extension mismatch? Better to serve ply)
            # We'll just make spz path also exist by copying ply content
            out_spz.write_bytes(ply_path.read_bytes())
            print(f"PLY fallback copied to SPZ path {out_spz}")
        except Exception as e2:
            print(f"ply fallback failed {e2}, creating dummy")
            out_spz.write_bytes(b"PLYDEMO" + os.urandom(2048))

    with tasks_lock:
        tasks[task_id]["status"] = "completed"
        tasks[task_id]["progress"] = 100
        tasks[task_id]["message"] = "Готово!"
        tasks[task_id]["download_url"] = f"/api/download/{task_id}"
        tasks[task_id]["generation_time"] = MOCK_GENERATION_SECONDS
        try:
            tasks[task_id]["file_size"] = out_spz.stat().st_size
        except:
            tasks[task_id]["file_size"] = 0
        tasks[task_id]["finished_at"] = time.time()

def real_generate_task(task_id: str, data: dict):
    try:
        with tasks_lock:
            tasks[task_id]["status"] = "running"
            tasks[task_id]["progress"] = 10
            tasks[task_id]["message"] = "Запуск модели..."

        # delegate to app.py logic
        import torch
        from PIL import Image
        import numpy as np
        from utils import create_raymaps, normalize_cameras, sample_from_dense_cameras, export_gaussians

        # Re-use app.process_generation_request style but directly call generation_system.generate
        # We need to replicate image handling
        image_prompt = data.get("image_prompt")
        text_prompt = data.get("text_prompt","")
        cameras = data.get("cameras")
        resolution = data.get("resolution")
        image_index = data.get("image_index",0)
        n_frame, image_height, image_width = resolution

        # Build image tensor if present
        image_tensor = None
        if image_prompt:
            if "," in image_prompt:
                b64 = image_prompt.split(",",1)[1]
            else:
                b64 = image_prompt
            img_bytes = base64.b64decode(b64 + "="*(-len(b64)%4))
            pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            # center crop logic from app.py
            w,h = pil.size
            if image_height/h > image_width/w:
                scale = image_height/h
            else:
                scale = image_width/w
            new_h = int(image_height/scale)
            new_w = int(image_width/scale)
            pil = pil.crop(((w-new_w)//2,(h-new_h)//2, new_w+(w-new_w)//2, new_h+(h-new_h)//2)).resize((image_width,image_height))
            # adjust cameras fx/fy/cx/cy
            for cam in cameras:
                cam["fx"] = cam["fx"] * scale
                cam["fy"] = cam["fy"] * scale
                cam["cx"] = (cam["cx"] - (w-new_w)//2)*scale
                cam["cy"] = (cam["cy"] - (h-new_h)//2)*scale
            arr = np.array(pil)
            image_tensor = torch.from_numpy(arr).float().permute(2,0,1)/255.0*2-1

        cameras_t = torch.stack([
            torch.tensor([c["quaternion"][0],c["quaternion"][1],c["quaternion"][2],c["quaternion"][3],
                          c["position"][0],c["position"][1],c["position"][2],
                          c["fx"]/image_width, c["fy"]/image_height, c["cx"]/image_width, c["cy"]/image_height], dtype=torch.float32)
            for c in cameras
        ],dim=0)

        with tasks_lock:
            tasks[task_id]["progress"] = 30
            tasks[task_id]["message"] = "Генерация 3D (это займёт ~7с на A100)..."
        start = time.time()
        scene_params, ref_w2c, T_norm = generation_system.generate(cameras_t, n_frame, image_tensor, text_prompt, image_index, image_height, image_width)
        gen_time = time.time() - start
        scene_params = scene_params.detach().cpu()
        out_spz = CACHE_DIR / f"{task_id}.spz"
        out_json = CACHE_DIR / f"{task_id}.json"
        out_json.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        # export
        from utils import export_gaussians
        export_gaussians(scene_params, opacity_threshold=0.00025, T_norm=T_norm, spz_path=str(out_spz))
        with tasks_lock:
            tasks[task_id]["status"] = "completed"
            tasks[task_id]["progress"] = 100
            tasks[task_id]["message"] = "Готово!"
            tasks[task_id]["download_url"] = f"/api/download/{task_id}"
            tasks[task_id]["generation_time"] = gen_time
            tasks[task_id]["file_size"] = out_spz.stat().st_size if out_spz.exists() else 0
    except Exception as e:
        import traceback; traceback.print_exc()
        with tasks_lock:
            tasks[task_id]["status"] = "failed"
            tasks[task_id]["error"] = str(e)
            tasks[task_id]["message"] = f"Ошибка: {e}"

# ---------- API Routes ----------
@app.get("/api/health")
def health():
    return {"status": "ok", "demo": DEMO_MODE, "gpu": False, "tasks": len(tasks)}

@app.get("/api/examples")
def list_examples():
    """Return list of example JSONs with thumbnail (image_prompt) and text"""
    examples = []
    if EXAMPLES_DIR.exists():
        for p in sorted(EXAMPLES_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
                # truncate base64 for transport: send as is but client will use it
                # To avoid huge payload, we send only thumb preview if possible: just first 100k chars?
                # Instead send image_prompt as is but we limit to 8 examples, it's okay ~5MB.
                # We'll optionally provide a thumb via query? Keep full.
                examples.append({
                    "id": p.stem,
                    "filename": p.name,
                    "text_prompt": data.get("text_prompt",""),
                    "image_prompt": data.get("image_prompt",""),
                    "resolution": data.get("resolution"),
                    "cameras_count": len(data.get("cameras",[])),
                })
            except Exception as e:
                print(f"skip {p}: {e}")
    return {"examples": examples}

@app.get("/api/examples/{ex_id}/json")
def get_example_json(ex_id: str):
    p = EXAMPLES_DIR / f"{ex_id}.json"
    if not p.exists():
        raise HTTPException(404, "example not found")
    return JSONResponse(json.loads(p.read_text()))

@app.post("/api/generate")
async def api_generate(request: Request):
    """Unified generate endpoint — accepts JSON with image_prompt as base64 data URL"""
    try:
        data = await request.json()
    except:
        raise HTTPException(400, "invalid json")

    # basic validation
    if not data.get("cameras") or len(data.get("cameras",[])) < 2:
        raise HTTPException(400, "Need at least 2 cameras")
    if not data.get("resolution") or len(data["resolution"])!=3:
        raise HTTPException(400, "resolution must be [n,h,w]")
    if not data.get("image_prompt") and not data.get("text_prompt"):
        raise HTTPException(400, "Provide image_prompt or text_prompt")

    task_id = create_task_id()
    with tasks_lock:
        tasks[task_id] = {
            "task_id": task_id,
            "status": "queued",
            "progress": 0,
            "message": "В очереди...",
            "created_at": time.time(),
            "data": data,
        }

    # Background
    if DEMO_MODE:
        threading.Thread(target=mock_generate_task, args=(task_id, data), daemon=True).start()
    else:
        threading.Thread(target=real_generate_task, args=(task_id, data), daemon=True).start()

    return {"task_id": task_id, "status": "queued"}

@app.get("/api/tasks/{task_id}")
def get_task(task_id: str):
    with tasks_lock:
        t = tasks.get(task_id)
        if not t:
            raise HTTPException(404, "task not found")
        # return public fields
        return {
            "task_id": t["task_id"],
            "status": t["status"],
            "progress": t["progress"],
            "message": t["message"],
            "download_url": t.get("download_url"),
            "generation_time": t.get("generation_time"),
            "file_size": t.get("file_size"),
            "error": t.get("error"),
            "queue": {
                "position": 0,
                "running_count": 1 if t["status"]=="running" else 0,
                "queued_count": 0,
            }
        }

@app.get("/api/download/{task_id}")
def download(task_id: str, ext: str = "spz"):
    # Try spz first, then ply
    p = CACHE_DIR / f"{task_id}.spz"
    if not p.exists():
        p = CACHE_DIR / f"{task_id}.ply"
        ext = "ply"
        if not p.exists():
            raise HTTPException(404, "file not found")
    else:
        # Check if file is actually PLY (starts with ply) — serve as ply
        try:
            head = p.read_bytes()[:4]
            if head == b"ply\n" or head[:3] == b"ply":
                ext = "ply"
        except:
            pass
    filename = f"scene-{task_id}.{ext}"
    media = "application/octet-stream" if ext=="spz" else "application/octet-stream"
    return FileResponse(str(p), media_type=media, filename=filename,
                        headers={"Content-Disposition": f"attachment; filename={filename}"})

@app.get("/api/download/{task_id}/ply")
def download_ply(task_id: str):
    p = CACHE_DIR / f"{task_id}.ply"
    if not p.exists():
        # try spz fallback
        p2 = CACHE_DIR / f"{task_id}.spz"
        if p2.exists():
            return FileResponse(str(p2), filename=f"scene-{task_id}.ply")
        raise HTTPException(404, "file not found")
    return FileResponse(str(p), filename=f"scene-{task_id}.ply")

@app.post("/api/delete/{task_id}")
def delete_task(task_id: str):
    with tasks_lock:
        tasks.pop(task_id, None)
    for ext in (".spz",".json",".mp4",".ply"):
        p = CACHE_DIR / f"{task_id}{ext}"
        try:
            if p.exists(): p.unlink()
        except: pass
    return {"success": True}

# Simple upload helper for frontend
@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    data = await file.read()
    b64 = base64.b64encode(data).decode("ascii")
    mime = file.content_type or "image/png"
    return {"dataUrl": f"data:{mime};base64,{b64}"}

# ---------- Frontend serving ----------
# Mount frontend static
if FRONTEND_DIR.exists():
    _assets_dir = FRONTEND_DIR / "assets"
    if _assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")
    # Also serve examples dir
    if EXAMPLES_DIR.exists():
        app.mount("/examples", StaticFiles(directory=str(EXAMPLES_DIR)), name="examples")

    @app.get("/", response_class=HTMLResponse)
    def serve_index():
        idx = FRONTEND_DIR / "index.html"
        if idx.exists():
            return HTMLResponse(idx.read_text(encoding="utf-8"))
        return HTMLResponse("<h1>Frontend not built</h1>", status_code=404)

    @app.get("/app", response_class=HTMLResponse)
    def serve_app():
        return serve_index()

    # SPA fallback for other paths
    @app.get("/{path:path}", response_class=HTMLResponse)
    def spa_fallback(path: str):
        # if path is api, already handled; otherwise serve index
        if path.startswith("api/"):
            raise HTTPException(404)
        idx = FRONTEND_DIR / "index.html"
        if idx.exists() and "." not in Path(path).name:
            return HTMLResponse(idx.read_text(encoding="utf-8"))
        # try static file
        cand = FRONTEND_DIR / path
        if cand.exists() and cand.is_file():
            # guess type
            if cand.suffix in (".js", ".mjs"):
                return HTMLResponse(cand.read_text(), media_type="application/javascript")
            if cand.suffix == ".css":
                return HTMLResponse(cand.read_text(), media_type="text/css")
            if cand.suffix == ".json":
                return FileResponse(str(cand), media_type="application/json")
        raise HTTPException(404)
else:
    @app.get("/")
    def no_frontend():
        return {"message": "frontend not found", "dir": str(FRONTEND_DIR)}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
