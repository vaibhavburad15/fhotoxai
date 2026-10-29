# ============================================
# General API Dockerfile
# Lightweight Python Image
# ============================================

FROM python:3.12-slim

WORKDIR /app

# ---------- System Dependencies ----------

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libpq-dev \
    python3-dev \
    curl \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# ---------- Install Node (needed for zip / utils / notifications) ----------

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# ---------- Node Dependencies (cached layer) ----------

COPY package*.json ./
RUN npm install --production || true \
    && npm install nodemailer

# ---------- Python Dependencies (cached layer) ----------
# Copy General API specific requirements

COPY requirements.txt requirements.txt

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# ---------- Copy Backend Source ----------

COPY . .

# ---------- Runtime Directories ----------

RUN mkdir -p \
    /app/uploads \
    /app/downloads \
    /app/banners

EXPOSE 3001

CMD ["python", "-m", "uvicorn", "general_api.main:app", "--host", "0.0.0.0", "--port", "3001"]
