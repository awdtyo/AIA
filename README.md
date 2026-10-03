# AIA Vote — Aadhaar ZK-Gated Permissioned Blockchain E-Voting

![status](https://img.shields.io/badge/status-prototype-orange)
![contracts](https://img.shields.io/badge/contracts-Solidity%20%5E0.8.23-blue)
![backend](https://img.shields.io/badge/backend-Express%20%2B%20TypeScript-green)
![web](https://img.shields.io/badge/web-Next.js%2014-black)
![privacy](https://img.shields.io/badge/PII_on_chain-none-red)

A hackathon prototype for the Election Commission of India: an **Aadhaar ZK-gated,
permissioned-blockchain** voting protocol with **EVM shadow-audit mode** and remote
voting for **migrants / NRIs**.

Voters prove eligibility once (mock Aadhaar/DigiLocker KYC in this prototype), join a
per-election Semaphore anonymity group, then vote with zero-knowledge proofs: the
**candidate choice is public, the voter's identity stays unlinkable**, and a nullifier
prevents double voting. Election control sits behind an **ECI multi-sig**; a backend
**relayer + indexer** keeps gas and UX simple; booth-level EVM counts can be
cross-checked against the on-chain tally through the **shadow-audit** endpoint, with
everything visible on a public explorer.

> **Prototype, not production.** Aadhaar/DigiLocker is fully mocked, the chain is a
> local Hardhat network, and several production hardening steps are still open (see
> [Production hardening](#production-hardening)). Do not use this for real elections.

---

## Table of contents

- [Key properties](#key-properties)
- [Architecture](#architecture)
- [Election lifecycle](#election-lifecycle)
- [Voter flow](#voter-flow)
- [Admin multi-sig flow](#admin-multi-sig-flow)
- [Privacy design](#privacy-design)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Smart contracts](#smart-contracts)
- [Shadow audit](#shadow-audit)
- [Testing](#testing)
- [Internationalization & accessibility](#internationalization--accessibility)
- [Scale notes](#scale-notes)
- [Production hardening](#production-hardening)
- [Contributing](#contributing)
- [License](#license)

---

## Key properties

| Property | How it holds |
|---|---|
| Eligibility-gated, anonymous voting | Semaphore ZK groups per election; chain sees commitments, proofs, nullifiers — never Aadhaar or PII |
| One person, one vote | `eligibilityHash = HMAC-SHA256(SERVER_SECRET, subjectId:electionId)` enforced unique; Semaphore nullifier blocks double votes on-chain |
| Public verifiability | All state changes emit events; backend indexer feeds explorer, turnout, tallies, receipts |
| ECI-controlled administration | `ECIMultiSig` (m-of-n) is the only actor that can create elections, advance phases, or rotate the registrar |
| EVM cross-check | Shadow-audit compares booth-level EVM counts against the chain tally |
| Remote voting | Web voter app works for migrants/NRIs; voters never need a wallet or gas (backend relays votes) |

---

## Architecture

```mermaid
flowchart TB
    subgraph Client["Voter device (browser)"]
        VoterApp["Web voter app<br/>(Next.js)"]
        SemProof["Semaphore identity<br/>+ proof generation<br/>(client-side)"]
    end
    subgraph BackendSvc["Backend (Express + TypeScript)"]
        API["REST /api"]
        KYC["Mock KYC"]
        Registrar["Registrar wallet"]
        Relayer["Relayer wallet<br/>(nonce-managed queue)"]
        Indexer["Chain indexer"]
        WS["WebSocket /ws"]
    end
    subgraph Chain["Permissioned chain"]
        MS["ECIMultiSig"]
        EM["ElectionManager"]
        SEMA["Semaphore"]
    end
    DB[("Postgres<br/>(registrations,<br/>indexed events)")]

    VoterApp --> SemProof
    VoterApp -->|"REST /api + /ws"| API
    API --> KYC
    API --> Registrar
    API --> Relayer
    Registrar -->|"registerVoter"| EM
    Relayer -->|"castVote"| EM
    MS -->|"owns / governs"| EM
    EM --> SEMA
    EM -->|"events"| Indexer
    Indexer --> DB
    Indexer --> WS
    API --> DB
    WS --> VoterApp
```

**Component responsibilities**

| Component | Owns | Never touches |
|---|---|---|
| `contracts/` | Election state, phase machine, Semaphore verification, multi-sig authorization | PII (only opaque commitments / nullifiers) |
| `backend/` | Mock KYC, one-per-person registration guard, vote relaying, event indexing, audit math | Aadhaar numbers, raw subject ids (JWT + memory only) |
| `web/` | Voter UX, client-side ZK proofs, explorer / turnout / receipts, admin multi-sig panel | Private keys (except local demo account), voter PII |

`docs/SPEC.md` is the source of truth for contracts + API. `docs/SCALE.md` analyzes the
path from prototype to national scale, and `contracts/BESU.md` covers the Hyperledger
Besu preview network.

---

## Election lifecycle

One `ElectionManager` election (and one Semaphore group) per constituency. Phases advance
exactly one step at a time, and only via the multi-sig.

```mermaid
stateDiagram-v2
    [*] --> Setup : createElection<br/>(multi-sig)
    Setup --> Registration : advancePhase
    Registration --> Voting : advancePhase
    Voting --> Tallying : advancePhase
    Tallying --> Finalized : advancePhase<br/>(emits TallyFinalized)
    Finalized --> [*]

    note right of Registration : registrar adds<br/>identity commitments
    note right of Voting : anyone relays<br/>Semaphore proofs
    note right of Tallying : tally readable<br/>on- and off-chain
```

| Phase | Value | What happens |
|---|---|---|
| `Setup` | 0 | Election created, group opened |
| `Registration` | 1 | Backend registrar wallet adds voter identity commitments |
| `Voting` | 2 | Relayers submit Semaphore proofs (`scope = electionId`, `message = candidateIndex`) |
| `Tallying` | 3 | Voting closed; tally readable |
| `Finalized` | 4 | Terminal; `TallyFinalized(electionId, tallyHash)` emitted |

---

## Voter flow

```mermaid
sequenceDiagram
    participant V as Voter (browser)
    participant W as Web app
    participant B as Backend /api
    participant C as ElectionManager

    V->>W: Enter mock EPIC
    W->>B: POST /kyc/start {electionId}
    B-->>W: {sessionId, redirectUrl}
    W->>B: POST /kyc/complete {sessionId, mockEpic}
    B-->>W: {kycToken} (10-min JWT)
    Note over V,W: Semaphore identity created<br/>client-side, stored in localStorage
    W->>B: POST /register {kycToken, electionId, identityCommitment}
    B->>B: eligibilityHash = HMAC(subjectId:electionId)<br/>unique per election
    B->>C: registerVoter(electionId, commitment)
    C-->>B: txHash
    B-->>W: {txHash}
    Note over V,W: Voting phase: fetch group,<br/>generate ZK proof in browser
    W->>B: POST /relay/vote {electionId, candidateIndex, proof}
    B->>C: castVote(...) via nonce-managed queue
    C-->>B: {txHash, voteHash}
    B-->>W: {txHash, voteHash}
    V->>W: Look up receipt by nullifier
    W->>B: GET /receipts/:nullifier
    B-->>W: {voteHash, txHash, blockNumber, timestamp}
```

Key details:

- The Semaphore identity never leaves the device; the backend only ever sees the
  **identity commitment** (registration) and the **proof + nullifier** (voting).
- `kycToken` is a short-lived JWT (default 600 s) binding `subjectId → electionId`;
  the election id inside it comes from the server-side session record, not the client.
- `POST /relay/vote` writes **no access log at all** (no IP/headers/user-agent) and its
  route logger records only `{ electionId, txHash }` plus error codes.

---

## Admin multi-sig flow

Every admin action is a `submit → approve (× threshold) → execute` transaction on
`ECIMultiSig`. The admin panel (`/en/admin`) decodes pending calldata into plain
language, so owners sign what they understand.

```mermaid
flowchart LR
    P["Propose<br/>(submit target+data)"] --> A["Approve<br/>(owner, once each)"]
    A -->|"approvals ≥ threshold (2-of-3)"| E["Execute<br/>(anyone)"]
    A -->|"still below threshold"| WAIT["Wait for more owners"]
    WAIT --> A
    E --> DONE["Election created /<br/>phase advanced"]
```

To stop invalid transactions from ever reaching wallets (previously the source of
"failed" MetaMask entries), the panel:

- simulates each action with `simulateContract` **before** sending, and decodes
  reverts (`NotOwner`, `AlreadyApproved`, `AlreadyExecuted`, `ThresholdNotMet`,
  `TxNotFound`, `ExecutionFailed`) into inline human-readable messages;
- disables all action buttons until every on-chain read has resolved (no more
  zero-threshold false-enables) and refetches pending transactions on every block,
  so two owners signing from different browsers always see fresh counts;
- asks for explicit confirmation on every phase change (on-chain actions are
  irreversible), and announces new proposal ids from the `Submitted` event.

Wallet setup: connect an injected wallet holding an owner key, or — on a local chain
only — use the built-in Hardhat demo account (`0xf39F…2266`). Voters never connect a
wallet anywhere.

---

## Privacy design

| Data | Stored where | Notes |
|---|---|---|
| Aadhaar / EPIC / raw `subjectId` | **Nowhere** (JWT + server memory only) | `subjectId = sha256(mockEpic)`; logs redact `kycToken`/`mockEpic`/`subjectId` |
| `eligibilityHash` | Postgres `registrations` | `HMAC-SHA256(SERVER_SECRET, subjectId:electionId)`, unique per election |
| Identity commitments | On-chain Semaphore group + indexer `group_members` | Opaque field elements; never stored next to `kycSubjectId`, never co-logged |
| Nullifiers / vote hashes | On-chain + indexer `votes` | Public by design; unlinkable to commitments |
| Voter IP on vote relay | **Not logged** (SPEC requirement) | Asserted by tests |

---

## Tech stack

| Layer | Stack |
|---|---|
| Chain | Solidity `^0.8.23`, Hardhat + TypeScript, OpenZeppelin, `@semaphore-protocol/contracts` |
| Backend | Express + TypeScript, Postgres, `ethers` v6, Semaphore `group/identity/proof`, `zod`, Swagger UI |
| Web | Next.js 14 (App Router) + TypeScript strict, Tailwind, `next-intl`, `wagmi`/`viem` (admin only), React Query, `recharts` |
| Dev | Node 20+, `docker compose` (Postgres 16), Hardhat node for the local chain |

Ports: chain `8545` · backend `4000` · web `3000` · Postgres `5432`.

---

## Repository layout

```text
.
├── contracts/            # Chain dev owns. Solidity + deploy/seed/verify scripts
│   ├── contracts/        # ECIMultiSig.sol, ElectionManager.sol
│   ├── scripts/          # deploy.ts, seed-demo.ts, tally-check.ts, export-abi.ts
│   ├── abi/              # Committed ABIs consumed by the backend (SPEC artifacts)
│   ├── deployments/      # <network>.json { ECIMultiSig, ElectionManager, Semaphore, chainId }
│   └── test/             # 35 Hardhat tests incl. real Semaphore proofs
├── backend/              # API dev owns. Express API + relayer + indexer
│   ├── src/              # app.ts, server.ts, config.ts, chain/, indexer/, kyc/, routes/
│   ├── migrations/       # 001_init, 002_indexer, 003_audit_runs (.sql, applied in order)
│   ├── openapi.yaml      # Full REST contract (also served at /api/docs)
│   └── tests/            # 53 vitest tests incl. live-relay integration
├── web/                  # Frontend dev owns. Voter app + explorer + admin
│   ├── src/app/[locale]/ # Routes: home, vote, receipt, explorer, turnout, admin
│   ├── src/app/api-mock/ # Mock backend (NEXT_PUBLIC_USE_MOCKS=true)
│   ├── src/components/   # Layout, elections, vote flow, explorer, turnout, admin
│   ├── src/lib/          # Typed API client, zod schemas, tally, proofs, multisig
│   ├── src/abi/          # Generated from contracts/abi (never import across packages)
│   ├── messages/         # en (source of truth), hi, ta, bn, te, mr
│   └── scripts/          # i18n-check.mjs, copy-abi.mjs
├── docs/                 # SPEC.md (source of truth — do not change in feature PRs), SCALE.md
├── docker-compose.yml    # Postgres 16
└── .env.example          # All config; copy to .env / backend/.env / web/.env.local
```

Ownership: stay inside your assigned package; shared files (`docs/SPEC.md`,
`docker-compose.yml`, `.env.example`, `.github/`, `AGENTS.md`, `README.md`) are
read-only in feature PRs unless the PR is explicitly a scaffold/infra PR.

---

## Prerequisites

- Node 20+ and `npm` (each package has its own `package.json`/lockfile — no workspaces)
- Docker (for Postgres) or a reachable Postgres 16
- No global Hardhat install needed (runs from `contracts/node_modules`)

---

## Quickstart

```bash
# 0. Configure (never commit .env files)
cp .env.example backend/.env        # fill in SERVER_SECRET, JWT_SECRET, wallet keys
cp web/.env.example web/.env.local # NEXT_PUBLIC_USE_MOCKS=false for the live stack

# 1. Postgres
docker compose up -d                # postgres:16 on 5432

# 2. Chain (terminal 1)
cd contracts && npm install && npm run node        # Hardhat node on :8545

# 3. Deploy + demo data (terminal 2, once per fresh node)
cd contracts \
  && npm run deploy:local \           # writes deployments/localhost.json (deterministic)
  && npm run abi \                    # refresh abi/ for the backend
  && npm run seed:demo                # 3 elections: Registration / Voting / Finalized

# 4. Backend (terminal 3)
cd backend && npm install && npm run migrate && npm run dev   # :4000

# 5. Web (terminal 4)
cd web && npm install && npm run dev                          # :3000 → /en
```

Verify the stack:

```bash
curl localhost:4000/api/health                       # {"ok":true}
curl localhost:4000/api/elections                    # 3 demo elections after seeding
curl -o /dev/null -w "%{http_code}\n" localhost:3000/en   # 200
```

**Demo handles.** Admin: import a Hardhat owner key (account `#0`
`0xf39F…2266`) into MetaMask on chain `31337`, or use the panel's Hardhat demo
account. Voter KYC: any EPIC matching `AA/12/345/678901` (e.g. `WB/12/345/678901`).
Deterministic voter identities land in gitignored `contracts/.demo/identities.json`
after seeding (private material — share out-of-band only).

---

## Configuration

All config flows through env files (see `.env.example`). The most important knobs:

| Var | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgresql://aiavote:aiavote@localhost:5432/aiavote` | backend |
| `RPC_URL` / `WS_RPC_URL` | `http://localhost:8545` / `ws://localhost:8545` | backend indexer + relayer |
| `CHAIN_ID` | `31337` | backend, web admin |
| `REGISTRAR_PRIVATE_KEY` | — (dev: Hardhat account) | backend voter registration |
| `RELAYER_PRIVATE_KEY` | — (dev: Hardhat account) | backend vote relay |
| `SERVER_SECRET` / `JWT_SECRET` | **must set** | eligibility HMAC / KYC tokens |
| `MOCK_KYC` | `true` | backend (`false` disables mock endpoints) |
| `CHAIN_MODE` | `auto` | backend (`fake` forces in-memory chain; `live` requires artifacts) |
| `ADMIN_API_KEY` | `""` (audit disabled) | backend shadow-audit gate |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | web |
| `NEXT_PUBLIC_USE_MOCKS` | `true` in example | web (`false` = live backend) |
| `MULTISIG_OWNERS` / `MULTISIG_THRESHOLD` | first 3 accounts / `2` | contract deploy |
| `INDEXER_FROM_BLOCK` | `0` | backend indexer backfill start |

---

## API reference

Base path `/api`, JSON, errors shaped `{ error: { code, message } }` with proper HTTP
status. Full contract in `backend/openapi.yaml` (browsable at `/api/docs`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/elections` | List elections |
| `GET` | `/elections/:id` | Detail + counts; `tally` only when phase ≥ Tallying |
| `GET` | `/elections/:id/turnout` | `{ registered, voted, turnoutPct }` |
| `GET` | `/elections/:id/votes?cursor=&limit=` | Paginated vote ledger (cursor-stable, max 200/page) |
| `GET` | `/elections/:id/group` | Identity commitments for the client-side Merkle tree |
| `GET` | `/receipts/:nullifier` | Vote receipt (or `{ found: false }`) |
| `POST` | `/kyc/start` | Begin mock KYC → `{ sessionId, redirectUrl }` |
| `POST` | `/kyc/complete` | Exchange session + mock EPIC for short-lived `kycToken` |
| `POST` | `/register` | Register commitment → `{ txHash }` (`409 ALREADY_REGISTERED` on duplicate) |
| `POST` | `/relay/vote` | Relay ZK vote → `{ txHash, voteHash }` (clean `4xx` for bad phase/proof/double-vote) |
| `POST` | `/elections/:id/audit` | Shadow-audit vs booth EVM counts (`x-admin-key` gated) |
| `GET` | `/elections/:id/audits` | Past audit runs |
| `WS` | `/ws` | Live `VoteCast` / `PhaseChanged` / `VoterRegistered` pushes |

Mock KYC curl (see `backend/README.md` for the relay shape, which needs a real proof):

```bash
BASE=http://localhost:4000/api
S=$(curl -s -X POST $BASE/kyc/start -H 'Content-Type: application/json' \
  -d '{"electionId":"1"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')
TOKEN=$(curl -s -X POST $BASE/kyc/complete -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$S\",\"mockEpic\":\"WB/12/345/678901\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["kycToken"])')
curl -X POST $BASE/register -H 'Content-Type: application/json' -d "{
  \"kycToken\": \"$TOKEN\", \"electionId\": \"1\",
  \"identityCommitment\": \"1234567890123456789012345678901234567890\" }"
```

---

## Smart contracts

Deployed stack per network (`contracts/deployments/<network>.json`):
`{ ECIMultiSig, ElectionManager, Semaphore, chainId }`. A fresh
`npm run node + npm run deploy:local` reproduces the localhost addresses
deterministically:

| Contract | localhost address |
|---|---|
| `ECIMultiSig` | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| `ElectionManager` | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| Semaphore | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |

**`ECIMultiSig`** — `constructor(owners, threshold)`; `submit(target, data)`,
`approve(txId)`, `execute(txId)` (anyone may execute once the threshold is met);
custom errors (`NotOwner`, `AlreadyApproved`, `AlreadyExecuted`,
`ThresholdNotMet`, …) instead of revert strings.

**`ElectionManager`** (owner = multi-sig, registrar = backend wallet) —
`createElection`, `advancePhase` (multi-sig only, one step); `registerVoter`
(registrar only, Registration phase); `castVote` (anyone may relay, Voting phase,
`scope = electionId`, `message = candidateIndex`, nullifier-enforced); views
`getTally`, `getElection`. Events: `ElectionCreated`, `PhaseChanged`,
`VoterRegistered`, `VoteCast` (with `voteHash = keccak256(electionId, nullifier,
candidateIndex)`), `TallyFinalized`.

Networks: `localhost` (dev), `amoy` (Polygon testnet path), `besu` (local Besu
preview — see `contracts/BESU.md`). `npm run tally:check -- <electionId>`
recomputes a tally from `VoteCast` events and prints `MATCH`/`MISMATCH`.

---

## Shadow audit

Booth EVM counts are summed per candidate and compared against the on-chain tally
recomputed from indexed votes; every booth's `counts` length must equal the candidate
count. Each run is persisted and listed via `GET /elections/:id/audits`.

```bash
curl -X POST $BASE/elections/2/audit -H 'Content-Type: application/json' \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -d '{"booths":[{"boothId":"b1","counts":[6,4]}]}'
# -> {"match":true,"chainTally":[6,4],"evmTally":[6,4],"diff":[0,0]}
```

Prototype gate: a shared-secret `x-admin-key` header. **Production must use ECI-signed
audit submissions instead** (documented in `backend/README.md` and `openapi.yaml`).

---

## Testing

| Package | Command | Coverage |
|---|---|---|
| contracts | `npm run lint && npm test` | 35 tests (multi-sig, elections, e2e with real Semaphore proofs); 100% lines/functions |
| backend | `npm run lint && npm test` | 53 tests (KYC, register, relay incl. nonce manager, reads, audit, indexer + live-relay integration) |
| web | `npm run lint && npm run typecheck && npm test && npm run i18n:check && npm run build` | 80 tests (tally, proofs, vote flow, explorer, admin decoding) |

The backend integration test relays a real Semaphore vote when a Hardhat node is up
(else it skips); with `NEXT_PUBLIC_USE_MOCKS=true` the whole web UI runs with no
backend at all (three demo elections served by `/api-mock` route handlers).

---

## Internationalization & accessibility

- Six locales: `en` (source of truth), `hi`, `ta`, `bn`, `te`, `mr` — every string,
  translated by machine draft and carrying `_review` notes for an official ECI
  translator to sign off before any pilot. `npm run i18n:check` enforces key parity.
- Saffron/green are decorative only; text colors clear WCAG AA (72 measured pairs).
- Charts (turnout curve, tally bars) always ship `<details>` data tables and
  `aria-label` summaries — numbers never depend on seeing pixels.

---

## Scale notes

See `docs/SCALE.md` for the full analysis. The shape that matters: one election (one
Semaphore group) per constituency (~2M electors ⇒ Merkle depth 21), so registration,
voting, and tallying partition naturally. Registration (one `addMember` per voter) is
the heaviest on-chain cost and spreads over the registration window; ~1.3M
`castVote` proofs per constituency need roughly a day of dedicated chain capacity at
30M gas / 2 s blocks — feasible only because constituencies poll on different days.
A permissioned QBFT chain with known ECI validators (not anonymous miners) gives
predictable block times and zero-fee voter transactions.

---

## Production hardening

Before anything resembling real use, at minimum:

1. **Real eligibility bridge** — replace `MOCK_KYC` with Aadhaar/DigiLocker-backed
   issuance of short-lived eligibility tokens; keep the "commitments only on-chain"
   invariant and get a DPDP review.
2. **Key management** — multi-sig owner keys, registrar/relayer keys, and
   `SERVER_SECRET`/`JWT_SECRET` move to HSM/KMS; no dev defaults anywhere.
3. **Signed audits** — replace `x-admin-key` with ECI-signed audit submissions.
4. **Chain operations** — permissioned validator set, monitoring/alerting on the
   indexer checkpoint lag, replay tooling (`npm run dev:replay`), backup/restore for
   Postgres, rate-limit tuning on `/relay/vote`.
5. **i18n sign-off** — official ECI translator review of all six locales.
6. **Load testing** — booth-scale proof generation on low-end phones, relay queue
   throughput, and explorer pagination under full-constituency data.

---

## Contributing

- One package per PR, small PRs (~300 lines), Conventional Commits
  (`feat:`, `fix:`, `test:`, `docs:`).
- Workflow: `git checkout -b feat/<area>-<task>` → `npm run lint && npm test` →
  push → `gh pr create --base main` with the template (including **Spec impact**).
  Never push to `main`, never merge your own PR — wait for admin/CODEOWNER review.
- `docs/SPEC.md` is the source of truth and never changes in a feature PR; spec
  change needed? Describe it in the PR and stop.
- Privacy rules are hard requirements: never store Aadhaar numbers (only
  `eligibilityHash`), never co-log commitments with subject ids, never log IPs on
  `/relay/vote`. Any PR touching KYC/registration/relay must confirm these still hold.

---

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Aditya Sarkar.
