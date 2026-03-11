FROM python:3.10-slim

# System deps for PyMuPDF
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libmupdf-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Qdrant local storage (persistent via Azure volume mount)
RUN mkdir -p /app/qdrant_data

EXPOSE 8000

CMD ["uvicorn", "backend.api:app", "--host", "0.0.0.0", "--port", "8000"]
