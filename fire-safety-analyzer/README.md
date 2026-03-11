# Fire Safety Analyzer

Analizza relazioni tecniche antincendio (PDF, formato DM 03/08/2015) ed estrae dati strutturati tramite LLM.

## Requisiti

- Python 3.10+
- Venv: `/home/sommojames/langgraph_env`
- `OPENAI_API_KEY` nel file `.env` (directory parent)

## Installazione

```bash
source /home/sommojames/langgraph_env/bin/activate
pip install pdfplumber python-multipart jinja2 openai langgraph
```

## Avvio

```bash
cd fire-safety-analyzer
source /home/sommojames/langgraph_env/bin/activate
python main.py
```

Apri http://localhost:8000 nel browser.

## Uso

1. Apri la dashboard nel browser
2. Trascina o seleziona un PDF di relazione tecnica antincendio
3. Clicca "Analizza"
4. Naviga i risultati: dati generali, edifici, compartimenti, profili di rischio
