"""Pydantic models — a faithful port of `src/lib/types.ts`.

Field names use camelCase aliases so the JSON the API emits matches exactly what
the existing React frontend already expects (it was built against the TanStack
server functions). `populate_by_name=True` lets us still construct models with
snake_case kwargs in Python.

Typing note: uses `Optional[...]` rather than `X | None` so the models evaluate
on Python 3.9 (PEP 604 union syntax in evaluated annotations is 3.10+).
"""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Temperature = Literal["Hot", "Warm", "Cold"]
InteractionType = Literal["call", "email", "meeting", "intro", "event", "note", "follow-up"]
PipelineStage = Literal["Prospecting", "Researching", "Outreach Sent", "Ready to Promote"]
PortfolioDomain = Literal["Security", "AI", "Data", "Cloud", "Logistics", "Supply Chain", "Silicon"]
EventFormat = Literal["in-person", "virtual", "hybrid"]

PORTFOLIO_DOMAINS: List[PortfolioDomain] = [
    "Security", "AI", "Data", "Cloud", "Logistics", "Supply Chain", "Silicon",
]


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class Interaction(CamelModel):
    id: str
    date: str
    type: InteractionType
    summary: str
    is_follow_up: Optional[bool] = Field(default=None, alias="isFollowUp")
    follow_up_complete: Optional[bool] = Field(default=None, alias="followUpComplete")


class Contact(CamelModel):
    id: str
    name: str
    title: str
    company: str
    email: str
    phone: str
    address: str
    prime: str
    sector: str
    areas_of_interest: List[str] = Field(default_factory=list, alias="areasOfInterest")
    temperature: Temperature
    port_co_intros: List[str] = Field(default_factory=list, alias="portCoIntros")
    events_attended: List[str] = Field(default_factory=list, alias="eventsAttended")
    events_invited: List[str] = Field(default_factory=list, alias="eventsInvited")
    interactions: List[Interaction] = Field(default_factory=list)
    last_contact: Optional[str] = Field(default=None, alias="lastContact")
    follow_up_pending: Optional[bool] = Field(default=None, alias="followUpPending")
    location: Optional[str] = None
    linkedin_url: Optional[str] = Field(default=None, alias="linkedinUrl")
    apollo_enriched: Optional[bool] = Field(default=None, alias="apolloEnriched")
    apollo_enriched_date: Optional[str] = Field(default=None, alias="apolloEnrichedDate")


class OutreachAttempt(CamelModel):
    id: str
    date: str
    method: str
    summary: str


class TargetLead(CamelModel):
    id: str
    name: str
    title: str
    company: str
    linkedin_url: str = Field(alias="linkedinUrl")
    email: str
    phone: str
    location: str
    sector: str
    stage: PipelineStage
    origin_source: str = Field(alias="originSource")
    outreach: List[OutreachAttempt] = Field(default_factory=list)
    notes: str


class PortfolioEmployee(CamelModel):
    id: str
    name: str
    title: str
    email: str
    linkedin_url: str = Field(alias="linkedinUrl")


class PortfolioEvent(CamelModel):
    id: str
    date: str
    name: str
    type: Literal["conference", "dinner", "webinar", "meeting"]
    status: Optional[Literal["completed", "planned"]] = None
    event_role: Optional[Literal["hosted", "sponsored"]] = Field(default=None, alias="eventRole")


class PortfolioIntro(CamelModel):
    id: str
    date: str
    target_name: str = Field(alias="targetName")
    target_company: str = Field(alias="targetCompany")
    introduced_by: str = Field(alias="introducedBy")
    outcome: str


class PortfolioCompany(CamelModel):
    id: str
    name: str
    sector: str
    domain: PortfolioDomain
    website: str
    linkedin_url: str = Field(alias="linkedinUrl")
    location: str
    description: str
    contact_name: str = Field(alias="contactName")
    contact_email: str = Field(alias="contactEmail")
    contact_phone: str = Field(alias="contactPhone")
    employees: List[PortfolioEmployee] = Field(default_factory=list)
    events: List[PortfolioEvent] = Field(default_factory=list)
    introductions: List[PortfolioIntro] = Field(default_factory=list)
    asana_fields: Optional[Dict[str, str]] = Field(default=None, alias="asanaFields")


class AsanaEvent(CamelModel):
    gid: str
    name: str
    date: str  # YYYY-MM-DD
    status: Literal["completed", "planned"]
    portcos: List[str] = Field(default_factory=list)
    role: Optional[Literal["hosted", "sponsored"]] = None
    type: Literal["conference", "dinner", "webinar", "meeting"]
    lead: Optional[str] = None
    format: Optional[EventFormat] = None
    sectors: List[str] = Field(default_factory=list)


class AsanaPortcoData(CamelModel):
    fields_by_company_name: Dict[str, Dict[str, str]] = Field(alias="fieldsByCompanyName")
    events_by_company_name: Dict[str, List[PortfolioEvent]] = Field(alias="eventsByCompanyName")


# ── Apollo ───────────────────────────────────────────────────────────────────


class EmploymentHistoryItem(CamelModel):
    title: str
    company: str
    current: bool


class ApolloEnrichmentResult(CamelModel):
    found: bool
    title: Optional[str] = None
    company: Optional[str] = None
    linkedin_url: Optional[str] = Field(default=None, alias="linkedinUrl")
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    headline: Optional[str] = None
    photo_url: Optional[str] = Field(default=None, alias="photoUrl")
    phone: Optional[str] = None
    phone_source: Optional[Literal["personal", "mobile", "work", "company", ""]] = Field(
        default=None, alias="phoneSource"
    )
    email: Optional[str] = None
    employment_history: Optional[List[EmploymentHistoryItem]] = Field(
        default=None, alias="employmentHistory"
    )
    raw_response: Optional[dict] = Field(default=None, alias="rawResponse")
    error: Optional[str] = None
    error_code: Optional[str] = Field(default=None, alias="errorCode")
    access_denied: Optional[bool] = Field(default=None, alias="accessDenied")


# ── Request bodies for the write-back / POST endpoints ───────────────────────


class AddNoteInput(CamelModel):
    contact_email: str = Field(alias="contactEmail")
    note_content: str = Field(alias="noteContent")
    requires_follow_up: bool = Field(alias="requiresFollowUp")


class AddEventInput(CamelModel):
    contact_email: str = Field(alias="contactEmail")
    event_name: str = Field(alias="eventName")
    type: str


class AddPortcoIntroInput(CamelModel):
    contact_email: str = Field(alias="contactEmail")
    portco_name: str = Field(alias="portcoName")


class AddContactInput(CamelModel):
    name: str
    role: str
    company: str
    email: str
    phone: str
    location: str
    prime: str
    sector: str
    temperature: str


class AddTargetInput(CamelModel):
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    company: str
    role: str
    linkedin: str
    email: str
    location: str
    sector: str
    stage: str
    source: str
    research_purpose: str = Field(alias="researchPurpose")


class ResolveFollowUpInput(CamelModel):
    contact_email: str = Field(alias="contactEmail")
    note_content: str = Field(alias="noteContent")
    resolved: bool


class EnrichContactInput(CamelModel):
    email: Optional[str] = None
    first_name: Optional[str] = Field(default=None, alias="firstName")
    last_name: Optional[str] = Field(default=None, alias="lastName")
    company: Optional[str] = None
    linkedin_url: Optional[str] = Field(default=None, alias="linkedinUrl")
