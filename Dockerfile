# FlashWorld Site — Production Dockerfile
FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PORT=7860
ENV FLASHWORLD_DEMO=1

WORKDIR /app

RUN apt-get update && apt-get install -y python3 python3-pip git libgl1 libglib2.0-0 zlib1g-dev build-essential cmake ninja-build && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
RUN pip3 install --no-cache-dir fastapi uvicorn python-multipart numpy plyfile pillow

# Optional GPU deps — uncomment for real inference
# RUN pip3 install torch torchvision --index-url https://download.pytorch.org/whl/cu124
# RUN pip3 install git+https://github.com/nerfstudio-project/gsplat.git@32f2a54d21c7ecb135320bb02b136b7407ae5712
# RUN pip3 install git+https://github.com/huggingface/diffusers.git@447e8322f76efea55d4769cd67c372edbf0715b8
# RUN pip3 install git+https://github.com/nianticlabs/spz.git@a4fc69e7948c7152e807e6501d73ddc9c149ce37

COPY . .

EXPOSE 7860

CMD ["sh", "-c", "python3 -m uvicorn webapp.backend.server:app --host 0.0.0.0 --port ${PORT}"]
