# Публикация FlashWorld Site

Готовый архив: `FlashWorld-site.zip` (5.8 MB)

## Что внутри
```
FlashWorld-site/
├── webapp/
│   ├── backend/server.py   — FastAPI + mock/реальная модель
│   └── frontend/           — index.html / app.js / style.css (RU, Spark viewer)
├── examples/               — 8 json с промптами и траекториями
├── models/                 — recon/vae/transformer
├── app.py / cli.py / utils.py / quant.py — оригинал FlashWorld
├── index.html              — старый демо-интерфейс
├── requirements.txt + web deps (fastapi, uvicorn, plyfile, numpy, pillow)
├── Dockerfile / docker-compose.yml
├── RUN.md — как запустить локально
├── webapp/README.md — документация сайта
└── LICENSE (Apache-2.0)
```

## Быстрый деплой

### 1) Локально / VPS (демо без GPU)
```bash
unzip FlashWorld-site.zip && cd FlashWorld-site
pip install fastapi uvicorn python-multipart numpy plyfile pillow
FLASHWORLD_DEMO=1 python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860
# → http://YOUR_IP:7860
```

### 2) Docker
```bash
docker compose up --build
# → http://localhost:7860
```

### 3) С GPU (реальная генерация ~7с)
```bash
pip install torch torchvision triton transformers omegaconf ninja einops moviepy accelerate opencv-python av plyfile ftfy gradio nanobind
pip install git+https://github.com/nerfstudio-project/gsplat.git@32f2a54d21c7ecb135320bb02b136b7407ae5712
pip install git+https://github.com/huggingface/diffusers.git@447e8322f76efea55d4769cd67c372edbf0715b8
pip install git+https://github.com/nianticlabs/spz.git@a4fc69e7948c7152e807e6501d73ddc9c149ce37
# скачай model.ckpt с https://huggingface.co/imlixinyang/FlashWorld
FLASHWORLD_DEMO=0 FLASHWORLD_CKPT=/path/model.ckpt python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860
```

### 4) Хостинги
- **HuggingFace Spaces** — выбери Docker, перенеси файлы, включи ZeroGPU, в UI сайта укажи HF_TOKEN
- **Vercel/Netlify** — фронтенд статика `webapp/frontend/` + бэкенд как serverless (адаптируй server.py)
- **Yandex Cloud / Timeweb** — `docker-compose.yml` из коробки

## Проверка после публикации
- `GET /api/health` → `{"status":"ok","demo":...}`
- `GET /api/examples` → 8 примеров
- Загрузи фото → зафиксируй камеру → добавь Orbit → Сгенерировать → скачай .ply/.spz

Требования: демо — 1 CPU / 512 MB RAM, прод — CUDA 12 + 24–51GB VRAM.
