"""Entry point: python main.py → avvia dashboard + API su localhost:8000."""

import logging
import sys
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)

# Carica .env dalla root del progetto o dalla directory parent
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Aggiungi la directory del progetto al path per gli import
sys.path.insert(0, str(Path(__file__).resolve().parent))

if __name__ == "__main__":
    print("Fire Safety Analyzer")
    print("Dashboard: http://localhost:8000")
    uvicorn.run(
        "backend.api:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(Path(__file__).resolve().parent)],
    )
