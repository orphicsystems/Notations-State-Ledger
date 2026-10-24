# State Ledger

**Keep evidence, versioned state and release decisions connected without confusing one for another.**

[Technical reference](TECHNICAL_REFERENCE.md) · [Component role](docs/STACK_ROLE.md) ·
[Company mandate](docs/COMPANY_MANDATE.md) ·
[Notations Engineering Terminal](https://github.com/atomtrapping/Notations-Systems-Terminal)

## Organization

**Notation Systems Inc.** is the parent organization in the owner-declared
parent/child company hierarchy. It is a scientific computing and systems
engineering company developing computational instruments, software and
interactive environments for understanding and building physical and virtual
systems.

Its development direction connects measurement, state estimation and sensor
fusion, scientific modelling, simulation and execution, from materials and
machines to interactive worlds. Each repository's implemented capabilities and
qualification limits remain those documented for that component.

| Activity area | Focus |
| --- | --- |
| **Notations Gaming** | Games, graphics, world building, interactive environments and gameplay simulation. |
| **Notations Manufacturing** | Design, machinery integration, process development, fabrication and production systems. |
| **Notations Laboratories** | Research and experimental validation in scientific computing, measurement, physics and chemistry modelling, materials and simulation. |

State Ledger is shared evidence and state infrastructure across these companies.
It retains and governs source material, versioned state, admission and releases;
domain products and information delivery retain their existing responsibilities.

Evidence, operation, execution and verification identities remain separate.
Game and simulation state do not acquire industrial evidence or canonical-state
authority through shared tooling. Cross-company handoffs use explicit contracts
and the existing admission, execution and release boundaries.

Scientific and industrial applications require calibration, uncertainty,
repeatability, validation and documented operating envelopes appropriate to the
application. Simulation alone does not validate a physical model or authorize
machinery control. Gaming prioritizes interaction, visual quality and play;
reusable simulations do not make gameplay state scientific evidence.

## NET micro-tool

| Identity | Value |
| --- | --- |
| User-facing name | **State Ledger** |
| Proposed NET namespace | `state.ledger` |
| Implementation repository | `Evidence-and-State-Management` |
| Existing provider identity | Evidence and State Management / ESM |
| Purpose | Retain evidence, inspect time-qualified state and manage explicit admission, correction, recall and release |

`state.ledger` is the agreed discovery/operation-family name for the NET-facing
capability. It is **not a newly implemented terminal command or a claim that a
new adapter is registered**. Existing interfaces in the technical reference
remain the runnable entry points; reads, retention, admission and release must
remain separately specified operations rather than one ambiguous mutation.

## What this tool contributes

State Ledger is the user-facing micro-tool name for ESM's information-retention
and governance capabilities. ESM remains broader than the tool label: it covers
physical-economy corpora, business information, operational review and scientific
evidence. Caravan, Tradewind, Landshark and Dossier Services retain their domain
and delivery responsibilities.

The documented local-file acquisition path retains bytes and produces a
recomputable receipt. The candidate-evidence adapter replays pinned CIW bundles,
verifies bindings and supports read-only review or optional `UNADMITTED`
retention. **Acquisition and retention do not admit canonical state, authorize
redistribution or publish a release.** Operator-declared policy is not independent
confirmation of source rights.

The existing corpus and desk demonstrations retain their fixture and operating
limits. This naming change does not establish live customer feeds, independent
verification, a licensed customer delivery or a completed frontend integration.

## Where it fits

[Data Intake](https://github.com/atomtrapping/Notations-Data-Intake)
acquires source material. NET owns investigation/session state and operation
dispatch; specialist providers own their numerical implementations. State Ledger
retains and governs the information those activities reference.
[Frame Mapper](https://github.com/atomtrapping/Notations-FrameMapper-RunTime) and the
geographic viewer consume explicit projections, not unrestricted private stores.

Evidence, operation specifications, execution attempts, results and verification
records keep distinct identities. A result enters governed state only through
an explicit admission boundary. A display link grants neither access nor
execution authority; fixture-scoped projections must not expose unadmitted data.

## Corpus maintenance backend

The local production backend now supports [retained maintenance plans](docs/CORPUS_MAINTENANCE.md).
An operator-declared artifact correction or withdrawal can identify dependent
normalizations and candidate builds from exact selected run receipts, save the
review plan, and reopen it with fresh integrity checks. The CLI and guarded
local API preserve the selected-run coverage limit. Plans do not execute
rebuilds, admit records, or activate releases.

## Existing interfaces and compatibility

Use [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md) for the existing local
terminal, corpus interfaces, MCP tools, setup, tests, deployment, rights and
operating constraints. The complete pre-micro-tool README is preserved there
**byte-for-byte using the same Git blob**, at the repository root so its relative
file links retain their base. The new overview supersedes its user-facing title,
not its technical limitations or policies.

The repository URL and existing `payload-os`, `payload.*`, `notationsos.*`,
`notation://`, environment-variable and `.payload` storage identities are
unchanged. Historical records and retained runtime pins are not relabelled.

## Negative-state distinctions

Rather than collapsing every missing or refused result into one null, this one has seven,
as defined by [the negative-state registry](src/domain/negativeStates.ts): unknown
is not empty; withdrawn is not false; refused is not false; not assessable is not
agreement; void is not empty; unanswerable is not absent; and absence is not a zero.
These are semantic invariants, not counts of files or implementation modules.

Read-only journal and source-result inspection is documented in
[Retained-result inspection](docs/RETAINED_RESULT_INSPECTION.md). It grants no
capture, recovery, admission, or release authority.

## Licence, rights and publication

Existing source notices, rights schedules, contributor/upstream terms and
publication boundaries remain in force. This documentation change does not
relicense material, change repository visibility, authorize acquisition or
release private evidence. Refer to the preserved technical reference and the
applicable source and policy documents for the existing terms.
