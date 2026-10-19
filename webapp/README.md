# FlashWorld Site — сайт для создания 3D-сцен по фото

Современный веб-сайт на базе [FlashWorld](https://github.com/artyomtitoff/FlashWorld) (ICLR 2026 oral) для генерации 3D-сцен из одного фото/текста. Рендер — Gaussian Splatting, просмотр — Spark.

**Демо:** `http://localhost:7860` (после запуска)

> Сайт полностью на русском, адаптивный, с drag&drop, галереей примеров, редактором траектории камеры и 3D-просмотрщиком.

---

## Быстрый старт (демо-режим без GPU)

Демо-режим не требует видеокарты и чекпоинта — генерация симулируется процедурным PLY (~6000 гауссиан, ~0.5MB), чтобы проверить весь пайплайн.

```bash
pip install fastapi uvicorn python-multipart numpy plyfile pillow --break-system-packages
FLASHWORLD_DEMO=1 python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860 --reload
# открой http://localhost:7860
```

**Что работает в демо:**
- Загрузка фото (авто-кроп под разрешение)
- Текстовый промпт (английский лучше)
- Настройка FOV, разрешения, траектории (шаблоны Orbit/Move, ручная WASD + Space)
- Галерея из `examples/*.json` (8 примеров)
- Симуляция прогресса 8с, скачивание PLY/SPZ
- 3D-просмотр Spark (если файл валидный — покажет облако; иначе — куб-инструкция)

---

## Запуск с реальной моделью (требует GPU)

Требуется ~24GB VRAM без оффлоада (16GB с `--offload_t5 --offload_transformer_during_vae`), CUDA 12.

```bash
# 1) зависимости FlashWorld
pip install torch torchvision  # + triton transformers omegaconf ninja einops moviepy accelerate opencv-python av plyfile ftfy gradio nanobind
pip install git+https://github.com/nerfstudio-project/gsplat.git@32f2a54d21c7ecb135320bb02b136b7407ae5712
pip install git+https://github.com/huggingface/diffusers.git@447e8322f76efea55d4769cd67c372edbf0715b8
pip install git+https://github.com/nianticlabs/spz.git@a4fc69e7948c7152e807e6501d73ddc9c149ce37
# sage-attention опционально

# 2) скачай чекпоинт (автоматически при первом запуске через huggingface_hub, или укажи путь)
export FLASHWORLD_CKPT=/path/to/model.ckpt  # по умолчанию качает imlixinyang/FlashWorld/model.ckpt

# 3) запусти бэкенд в прод-режиме
FLASHWORLD_DEMO=0 python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860
# время генерации ~7с на A100, ~16с с offload_t5

# Также можно использовать CLI для лучшего качества (без компрессии гауссиан):
python cli.py --input_dir ./examples --output_dir ./out --spz --ply --video
```

Бэкенд использует тот же `GenerationSystem` что и `app.py`, но с REST API:
- `POST /api/generate` — создать задачу (image_prompt base64, text_prompt, cameras, resolution)
- `GET /api/tasks/{id}` — статус/прогресс
- `GET /api/download/{id}` — скачать SPZ/PLY
- `GET /api/examples` — список примеров
- `GET /api/health` — проверка демо/GPU

---

## Структура

```
webapp/
  frontend/
    index.html  — современный UI (русский, темная тема, glass)
    style.css   — дизайн-система
    app.js      — логика: загрузка, камеры, Spark viewer, API polling
  backend/
    server.py   — FastAPI + мок-генерация + прод-интеграция
  README.md
```

Frontend — vanilla JS + Three.js + Spark (через importmap, без сборки). Общается с бэкендом по REST, показывает прогресс-бар, очередь, скачивание.

Камера:
- Ручная: WASD/RF/QE + мышь, Space — записать
- Шаблон: Move Forward/Back/Left/Right, Orbit Left/Right 15°
- JSON: загрузка/сохранение траектории и All JSON (с фото+текст+камеры)

---

## Оригинальный FlashWorld интерфейс

Старый интерфейс сохранен: `index.html` (корень) + `app.py` (Gradio + FastAPI на `/app`).

Запуск оригинала:
```bash
python app.py  # http://localhost:7860/app
python cli.py --input_dir ./examples --output_dir ./out --spz --ply --video
```

---

## Деплой

- **Docker**: собери образ с `torch + gsplat + diffusers + spz` и `FLASHWORLD_DEMO=0`
- **HuggingFace Spaces**: используй ZeroGPU, укажи HF_TOKEN в UI (передается как Authorization Bearer)
- **Reverse proxy**: бэкенд отдает фронтенд на `/` и API на `/api/*`, поддержка CORS включена.

Кэш: `/tmp/flashworld_site/{id}.spz|.ply|.json` — очищается каждые 5 мин (30 мин ttl).

---

## Лицензия

Apache-2.0 (как FlashWorld)
