"""LangGraph graph: PDF ingestion → header extraction → structure extraction."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, TypedDict

import pdfplumber
from langgraph.graph import END, StateGraph
from openai import OpenAI

logger = logging.getLogger(__name__)

from backend.models import (
    Building,
    ExtractionResult,
    ReportHeader,
)

MODEL = "gpt-5"


def _resolve_refs(schema: dict) -> dict:
    """Inline all $defs/$ref so OpenAI gets a flat JSON schema."""
    # Collect all $defs from any level
    all_defs: dict = {}

    def _collect_defs(node):
        if isinstance(node, dict):
            if "$defs" in node:
                all_defs.update(node["$defs"])
            for v in node.values():
                _collect_defs(v)
        elif isinstance(node, list):
            for item in node:
                _collect_defs(item)

    _collect_defs(schema)

    def _resolve(node):
        if isinstance(node, dict):
            if "$ref" in node:
                ref_name = node["$ref"].split("/")[-1]
                resolved = _resolve(dict(all_defs[ref_name]))
                extra = {k: v for k, v in node.items() if k != "$ref"}
                resolved.update(extra)
                return resolved
            return {k: _resolve(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [_resolve(item) for item in node]
        return node

    return _resolve(schema)


class GraphState(TypedDict, total=False):
    pdf_path: str
    pdf_text: str
    header: dict[str, Any]
    buildings: list[dict[str, Any]]


def _get_client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY non impostata")
    return OpenAI(api_key=api_key, max_retries=5)


def _log_usage(description: str, resp) -> None:
    """Log token usage and cache stats from an OpenAI response."""
    usage = resp.usage
    if not usage:
        logger.info("[GPT] %s — no usage data", description)
        return
    cached = getattr(usage, "prompt_tokens_details", None)
    cached_tokens = getattr(cached, "cached_tokens", 0) if cached else 0
    logger.info(
        "[GPT] %s — input: %d tokens (cached: %d), output: %d tokens",
        description,
        usage.prompt_tokens,
        cached_tokens,
        usage.completion_tokens,
    )


# ── Node 1: PDF ingestion (no LLM) ──────────────────────────────

def pdf_ingestion(state: GraphState) -> GraphState:
    pages: list[str] = []
    with pdfplumber.open(state["pdf_path"]) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages.append(text)
    return {"pdf_text": "\n\n".join(pages)}


# ── Node 2: Header extraction ───────────────────────────────────

HEADER_SCHEMA = _resolve_refs(ReportHeader.model_json_schema())

HEADER_SYSTEM = """\
Sei un esperto di prevenzione incendi italiano. Estrai le informazioni di \
intestazione dalla relazione tecnica antincendio fornita.

Regole:
- Estrai SOLO ciò che è esplicitamente scritto nel documento.
- Usa null per qualsiasi campo non presente. Non inventare nulla.
- Per le attività D.P.R. n. 151/11: estrai TUTTE le attività soggette, \
ciascuna con il suo codice completo (numero/categoria/lettera, es. "70/2/C") \
e la descrizione come riportata nel documento (es. "Locali adibiti ad esposizione \
e/o vendita..."). Possono essere più di una (attività principale + secondarie)."""


def header_extractor(state: GraphState) -> GraphState:
    client = _get_client()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": HEADER_SYSTEM},
            {"role": "user", "content": state["pdf_text"]},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": "report_header",
                "description": "Intestazione della relazione tecnica",
                "parameters": HEADER_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "report_header"}},
        reasoning_effort="low",
    )
    _log_usage("Header extraction (intestazione relazione)", resp)
    tool_call = resp.choices[0].message.tool_calls[0]
    header_data = json.loads(tool_call.function.arguments)
    return {"header": header_data}


# ── Node 3: Structure extraction ────────────────────────────────

BUILDINGS_SCHEMA = _resolve_refs({
    "type": "object",
    "properties": {
        "buildings": {
            "type": "array",
            "items": Building.model_json_schema(),
        }
    },
    "required": ["buildings"],
})

STRUCTURE_SYSTEM = """\
Sei un esperto di prevenzione incendi italiano. Dalla relazione tecnica, \
estrai la gerarchia: EDIFICI → COMPARTIMENTI → LOCALI.

## IDENTIFICAZIONE EDIFICI
- Un "edificio" è un corpo di fabbrica fisicamente distinto (es. "corpo esistente", \
"nuovo corpo", "palazzina uffici", "capannone produzione").
- ATTENZIONE AL DOUBLE COUNTING: lo stesso edificio può essere chiamato con nomi \
diversi in parti diverse del documento (es. "corpo esistente" e "plesso esistente", \
oppure "nuovo corpo" e "nuovo plesso"). Sono lo STESSO edificio — creane uno solo, \
scegliendo il nome più descrittivo.
- I locali tecnici isolati (es. "locale tecnico gruppo pompaggio", "cabina elettrica") \
che sono fisicamente separati dagli edifici principali vanno come compartimento di un \
edificio "Locali tecnici esterni" (creane uno solo che li raggruppa).
- Gli ambiti all'aperto (parchi silos, depositi scoperti, piazzali) sono compartimenti \
con ambito_aperto: true. Raggruppali sotto un edificio "Ambiti esterni" se non \
appartengono chiaramente a un edificio specifico.

## GERARCHIA ESCLUSIVA
- Ogni locale appartiene a UN SOLO compartimento.
- Ogni compartimento appartiene a UN SOLO edificio.
- Non duplicare: se un locale appare in più tabelle/sezioni del documento, inseriscilo \
una sola volta nel compartimento corretto.
- Se un compartimento coincide con un singolo ambiente, crea comunque un Room con lo \
stesso nome del compartimento.

## PROFILI DI RISCHIO (Rvita, Rbeni, Rambiente)
I profili possono essere assegnati a vari livelli nel documento:
- A livello di intera attività o edificio → propagali (push_down) a OGNI compartimento.
- A livello di compartimento → assegnali direttamente (direct).
- A livello di locale → il compartimento eredita il più conservativo (push_up).

### Rvita (DM 03/08/2015, Codice Prevenzione Incendi)
- Estrai il profilo Rvita risultante (es. "A2", "A3", "B2").
- razionale_rvita: copia/riassumi il testo del documento che spiega perché il \
progettista ha scelto questo Rvita.
- Estrai SEMPRE i seguenti parametri quando il documento contiene informazioni \
sufficienti per determinarli (anche se non sono dichiarati esplicitamente con \
questi nomi):
  - delta_occ (δocc): caratteristica prevalente degli occupanti. Valori: \
"A" (familiarità con edificio, veglia), "B" (veglia), "C" (presenza di dormenti), \
"D" (occupanti con disabilità o in custodia), "E" (senza familiarità con l'edificio). \
NOTA: δocc si può dedurre anche dal tipo di attività e dal profilo Rvita. \
Es: Rvita="A3" → la lettera indica δocc (A=familiarità+veglia), il numero indica δα.
  - razionale_delta_occ: perché questo δocc.
  - delta_alpha (δα): velocità prevalente di crescita dell'incendio. Valori: \
"1" (lenta, tα=600s), "2" (media, tα=300s), "3" (rapida, tα=150s), "4" (ultra-rapida, tα=75s). \
NOTA: δα si ricava anche dal profilo Rvita. Es: Rvita="A3" → δα=3 (rapida). \
Rvita="B2" → δα=2 (media). Il NUMERO nel codice Rvita È il δα. \
Se il documento dichiara Rvita ma non δα esplicitamente, DEDUCI δα dal numero.
    * δα=1: qf ≤ 200 MJ/m² o materiali con contributo trascurabile
    * δα=2: materiali con contributo moderato all'incendio
    * δα=3: plastici impilati, tessili sintetici, apparecchiature elettriche, \
impilamento 3<h≤5m, stoccaggi HHS3/HHP1
    * δα=4: impilamento h>5m, stoccaggi HHS4/HHP2-4, plastici cellulari/espansi, \
sostanze pericolose
  - razionale_delta_alpha: perché questo δα (materiali presenti, tipo di lavorazione).
  - carico_incendio_mj_m2: carico di incendio specifico qf in MJ/m². \
Cerca valori espressi come "qf = ... MJ/m²", "carico di incendio specifico", \
"carico d'incendio", o in tabelle con intestazioni tipo "qf", "MJ/m²", "carico incendio". \
Può essere indicato come valore statistico (da DM 18.10.2019) o calcolato.
  - razionale_carico_incendio: copia il testo che descrive come è stato \
determinato il qf (materiali combustibili, metodo di calcolo, frattile).

### Rbeni
- Valore intero da 1 a 4. Cerca nel documento: "Rbeni", "rischio beni", \
"profilo di rischio beni", o tabelle riepilogative dei profili di rischio.
- razionale_rbeni: perché questo valore (es. "edificio senza valore strategico \
o artistico particolare").
- NOTA: se il documento dichiara i profili di rischio in una tabella riassuntiva, \
Rbeni sarà quasi sempre presente. Non lasciarlo null se è nel documento.

### Rambiente
- Tipicamente "non significativo" o "significativo". Cerca: "Rambiente", \
"rischio ambiente", "rischio ambientale", o tabelle riepilogative dei profili.
- razionale_rambiente: perché questa valutazione (es. "assenza di sostanze \
pericolose per l'ambiente").
- NOTA: come Rbeni, spesso è in tabelle riepilogative. Estrailo sempre se presente.

### IMPORTANTE: Razionali
Per OGNI campo razionale_*, copia il testo rilevante dal documento del progettista. \
Può essere lungo (più frasi). Includi il ragionamento completo, non solo un riassunto. \
Se il documento non fornisce un razionale esplicito, usa null.

### Propagazione
- source = "push_down": profilo assegnato a livello superiore (edificio/attività), \
propagato ai compartimenti.
- source = "push_up": profilo assegnato ai locali, compartimento eredita il più alto.
- source = "direct": profilo assegnato direttamente al compartimento.
- source_text: frammento breve (max 300 char) che identifica dove nel doc si trova il profilo.
- note_riduzione: se il profilo è stato ridotto (es. per presenza sprinkler), riportare la nota.

## MISURE ANTINCENDIO (S.1 – S.10, DM 03/08/2015)
Per ogni compartimento, estrai le misure antincendio dichiarate nel documento.
Le misure del Codice di Prevenzione Incendi sono:
- S.1: Reazione al fuoco
- S.2: Resistenza al fuoco
- S.3: Compartimentazione
- S.4: Esodo
- S.5: Gestione della sicurezza antincendio
- S.6: Controllo dell'incendio
- S.7: Rivelazione ed allarme
- S.8: Controllo di fumi e calore
- S.9: Operatività antincendio
- S.10: Sicurezza degli impianti tecnologici e di servizio

Per ciascuna misura presente nel documento:
- codice: "S.1", "S.2", etc.
- nome: nome della misura
- livello_prestazione: livello dichiarato dal tecnico (es. "I", "II", "III", "IV")
- razionale_livello: perché il progettista ha scelto questo livello (es. "Livello III \
richiesto per Rvita A3 secondo tabella S.2-3 del Codice; applicata soluzione conforme \
per compartimento produzione").
- soluzione_tecnica: descrizione della soluzione adottata (es. "materiali classe A2-s1,d0", \
"REI 120", "sprinkler UNI EN 12845", "EVAC conforme UNI ISO 7240-19")
- razionale_soluzione: perché questa soluzione (es. "strutture in c.a. con R 120, \
soluzione conforme S.2.4.2; solaio in lamiera grecata protetto con intonaco REI 120").
- source_text: frammento breve del documento (max 300 char)
- NON compilare il campo "validation" — sarà popolato dal validatore.

Le misure possono essere dichiarate a livello di compartimento o di edificio. \
Se dichiarate a livello di edificio, associale a OGNI compartimento di quell'edificio.
Estrai solo le misure esplicitamente menzionate nel documento.

## REGOLE GENERALI
- Usa null per campi non trovati nel documento. Non inventare nulla.
- NON compilare i campi "validation" — lascia il default.
- Per superficie_mq, estrai solo valori esplicitamente scritti.
- Per il piano dei locali, usa la denominazione del documento (es. "PT", "P1", "Interrato")."""


def structure_extractor(state: GraphState) -> GraphState:
    client = _get_client()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": STRUCTURE_SYSTEM},
            {"role": "user", "content": state["pdf_text"]},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": "buildings_structure",
                "description": "Struttura edifici, compartimenti, locali e profili di rischio",
                "parameters": BUILDINGS_SCHEMA,
            },
        }],
        tool_choice={"type": "function", "function": {"name": "buildings_structure"}},
        reasoning_effort="medium",
    )
    _log_usage("Structure extraction (edifici/compartimenti/locali + profili rischio + misure)", resp)
    tool_call = resp.choices[0].message.tool_calls[0]
    data = json.loads(tool_call.function.arguments)
    return {"buildings": data["buildings"]}


# ── Graph assembly ──────────────────────────────────────────────

def build_graph() -> StateGraph:
    graph = StateGraph(GraphState)
    graph.add_node("pdf_ingestion", pdf_ingestion)
    graph.add_node("header_extractor", header_extractor)
    graph.add_node("structure_extractor", structure_extractor)
    graph.set_entry_point("pdf_ingestion")
    graph.add_edge("pdf_ingestion", "header_extractor")
    graph.add_edge("header_extractor", "structure_extractor")
    graph.add_edge("structure_extractor", END)
    return graph.compile()


def run_extraction(pdf_path: str) -> ExtractionResult:
    """Esegue il grafo e ritorna il risultato validato."""
    app = build_graph()
    result = app.invoke({"pdf_path": pdf_path})
    return ExtractionResult(
        header=ReportHeader(**result["header"]),
        buildings=[Building(**b) for b in result["buildings"]],
    )
