"""Pydantic v2 models for fire safety report extraction."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# ── Validation (shared by risk profiles and measures) ────────────

ValidationStatus = Literal["not_validated", "ok", "warning", "error"]


class Validation(BaseModel):
    status: ValidationStatus = "not_validated"
    message: str | None = None
    expected: str | None = Field(
        None, description="Valore atteso secondo la norma"
    )


# ── Header ───────────────────────────────────────────────────────

class AttivitaDPR(BaseModel):
    """Singola attività secondo D.P.R. n. 151/11."""
    codice: str = Field(description="Es. '70/2/C', '44/3/B'")
    descrizione: str | None = Field(
        None,
        description="Descrizione dell'attività secondo l'allegato I del DPR 151/11",
    )


class ReportHeader(BaseModel):
    tecnico_firmatario: str | None = None
    studio_tecnico: str | None = None
    committente_nome: str | None = None
    committente_indirizzo: str | None = None
    attivita_descrizione: str | None = None
    attivita_dpr: list[AttivitaDPR] = Field(
        default_factory=list,
        description="Attività secondo D.P.R. 151/11 con codice e descrizione",
    )
    ubicazione: str | None = None
    data_relazione: str | None = None
    riferimento_pratica: str | None = None
    tipo_pratica: str | None = None

    @field_validator("attivita_dpr", mode="before")
    @classmethod
    def _coerce_attivita(cls, v):
        return v if v is not None else []


# ── Risk profiles ────────────────────────────────────────────────

class RiskProfile(BaseModel):
    rvita: str | None = Field(None, description="Es. 'A2', 'A3', 'B2'")
    razionale_rvita: str | None = Field(
        None,
        description="Razionale del progettista per la scelta di Rvita",
    )
    delta_occ: str | None = Field(
        None,
        description="Caratteristica prevalente degli occupanti (δocc). "
        "Es. 'A', 'B', 'C', 'D', 'E'",
    )
    razionale_delta_occ: str | None = Field(
        None,
        description="Razionale: perché questo δocc (tipo di occupanti)",
    )
    delta_alpha: str | None = Field(
        None,
        description="Velocità prevalente di crescita dell'incendio (δα). "
        "Es. '1' (lenta), '2' (media), '3' (rapida), '4' (ultra-rapida)",
    )
    razionale_delta_alpha: str | None = Field(
        None,
        description="Razionale: perché questo δα (materiali, carico d'incendio)",
    )
    carico_incendio_mj_m2: float | None = Field(
        None,
        description="Carico di incendio specifico qf in MJ/m2, se dichiarato",
    )
    razionale_carico_incendio: str | None = Field(
        None,
        description="Razionale: materiali presenti, metodo di calcolo del qf",
    )
    rbeni: int | None = Field(None, description="1, 2, 3 o 4")
    razionale_rbeni: str | None = Field(
        None,
        description="Razionale: perché questo Rbeni (valore strategico/artistico)",
    )
    rambiente: str | None = Field(
        None, description="Es. 'non significativo', 'significativo'"
    )
    razionale_rambiente: str | None = Field(
        None,
        description="Razionale: perché questo Rambiente",
    )
    note_riduzione: str | None = None
    source: Literal["direct", "push_down", "push_up"] = "direct"
    source_text: str | None = Field(
        None, max_length=300, description="Frammento del PDF"
    )
    validation: Validation = Field(default_factory=Validation)


# ── Fire safety measures S.1 – S.10 ─────────────────────────────

MEASURE_CODES = Literal[
    "S.1", "S.2", "S.3", "S.4", "S.5",
    "S.6", "S.7", "S.8", "S.9", "S.10",
]

MEASURE_NAMES: dict[str, str] = {
    "S.1": "Reazione al fuoco",
    "S.2": "Resistenza al fuoco",
    "S.3": "Compartimentazione",
    "S.4": "Esodo",
    "S.5": "Gestione della sicurezza antincendio",
    "S.6": "Controllo dell'incendio",
    "S.7": "Rivelazione ed allarme",
    "S.8": "Controllo di fumi e calore",
    "S.9": "Operatività antincendio",
    "S.10": "Sicurezza degli impianti tecnologici e di servizio",
}


class Measure(BaseModel):
    codice: MEASURE_CODES = Field(description="Es. 'S.1', 'S.2'")
    nome: str | None = Field(
        None,
        description="Nome della misura, es. 'Reazione al fuoco'",
    )
    livello_prestazione: str | None = Field(
        None,
        description="Livello di prestazione dichiarato, es. 'I', 'II', 'III'",
    )
    razionale_livello: str | None = Field(
        None,
        description="Razionale della scelta del livello di prestazione",
    )
    soluzione_tecnica: str | None = Field(
        None,
        description="Soluzione tecnica adottata, es. 'REI 120', 'sprinkler'",
    )
    razionale_soluzione: str | None = Field(
        None,
        description="Razionale della soluzione tecnica adottata",
    )
    source_text: str | None = Field(
        None, max_length=300, description="Frammento del PDF"
    )
    validation: Validation = Field(default_factory=Validation)


# ── Geometry ─────────────────────────────────────────────────────

class Room(BaseModel):
    nome: str
    piano: str | None = None


class Compartment(BaseModel):
    id: str = Field(description="Es. 'C1', 'E1-C2'")
    nome: str
    superficie_mq: float | None = None
    multipiano: bool | None = None
    ambito_aperto: bool = Field(
        False,
        description="True per parchi silos, depositi scoperti",
    )
    locali: list[Room] = Field(default_factory=list)
    risk_profile: RiskProfile | None = None
    measures: list[Measure] = Field(
        default_factory=list,
        description="Misure antincendio S.1-S.10 applicabili al compartimento",
    )

    @field_validator("locali", mode="before")
    @classmethod
    def _coerce_locali(cls, v):
        return v if v is not None else []

    @field_validator("measures", mode="before")
    @classmethod
    def _coerce_measures(cls, v):
        return v if v is not None else []


class Building(BaseModel):
    id: str = Field(description="Es. 'E1', 'E2'")
    nome: str
    compartments: list[Compartment] = Field(default_factory=list)

    @field_validator("compartments", mode="before")
    @classmethod
    def _coerce_compartments(cls, v):
        return v if v is not None else []


class ExtractionResult(BaseModel):
    header: ReportHeader
    buildings: list[Building] = Field(default_factory=list)

    @field_validator("buildings", mode="before")
    @classmethod
    def _coerce_buildings(cls, v):
        return v if v is not None else []
