# Как запустить сайт

## 1. Быстрый старт — демо без GPU (рекомендуется для проверки)

```bash
pip install fastapi uvicorn python-multipart numpy plyfile pillow --break-system-packages
FLASHWORLD_DEMO=1 python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860 --reload
```

Открой: http://localhost:7860

- Загрузи фото или введи текст (на английском)
- Нажми «Зафиксировать камеру», затем добавь камеры (WASD + Space или шаблон)
- Нажми «Сгенерировать сцену» — увидишь прогресс 8с и скачаешь PLY (синтетический, для проверки пайплайна)

## 2. Реальная генерация (GPU)

```bash
pip install torch torchvision triton transformers omegaconf ninja einops moviepy accelerate opencv-python av plyfile ftfy gradio nanobind
pip install git+https://github.com/nerfstudio-project/gsplat.git@32f2a54d21c7ecb135320bb02b136b7407ae5712
pip install git+https://github.com/huggingface/diffusers.git@447e8322f76efea55d4769cd67c372edbf0715b8
pip install git+https://github.com/nianticlabs/spz.git@a4fc69e7948c7152e807e6501d73ddc9c149ce37

FLASHWORLD_DEMO=0 python -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port 7860
```

Требует ~51GB VRAM (или 24GB с --offload_t5 --offload_transformer_during_vae, 9GB с --offload_vae). Время ~7с на A100.

## 3. Оригинальный интерфейс FlashWorld

```bash
python app.py
# http://localhost:7860/app
```
