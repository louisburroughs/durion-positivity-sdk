## @durion-sdk/seeder@0.1.0-alpha

A year-scale data seeder for the Durion Positivity Backend. Simulates a full automotive shop operation using an accelerated clock profile, driving all major SDK domains: security, location, people, catalog, inventory, customer, workorder, invoice, and accounting.

---

### Prerequisites

- A running Durion Positivity Backend (default: `http://localhost:8080`)
- Node.js 18+
- Dependencies installed from the monorepo root: `npm install`

---

### Running

Use the provided PowerShell script from the monorepo root:

```powershell
.\run-seeder.ps1
```

Or run directly with environment variables:

```powershell
$env:SEEDER_BASE_URL = "http://localhost:8080"
$env:SEEDER_USERNAME = "your-username"
$env:SEEDER_PASSWORD = "your-password"
npm run seed -w packages/sdk-seeder
```

To simulate a single day:

```powershell
npm run seed:day -w packages/sdk-seeder
```

---

### Configuration

All configuration is via environment variables.

| Variable | Default | Required | Description |
|---|---|---|---|
| `SEEDER_BASE_URL` | `http://localhost:8080` | No | API gateway base URL |
| `SEEDER_SECURITY_SERVICE_URL` | `http://localhost:8086` | No | Direct security service URL |
| `SEEDER_USERNAME` | — | **Yes** | Login username |
| `SEEDER_PASSWORD` | — | **Yes** | Login password |
| `SEEDER_DAYS` | `365` | No | Number of virtual days to simulate |
| `SEEDER_SCALE` | `1000` | No | Time compression factor (sleep between days = `86400000 / scale` ms) |
| `SEEDER_SEED` | *(random)* | No | Integer RNG seed for reproducible runs |
| `SEEDER_MIN_CUSTOMERS_PER_DAY` | `4` | No | Minimum customer events per virtual day |
| `SEEDER_MAX_CUSTOMERS_PER_DAY` | `12` | No | Maximum customer events per virtual day |

At the default scale of 1000, each virtual day takes approximately 86 seconds of real time, so a full 365-day run completes in roughly 9 hours.

---

### How It Works

The seeder runs in two sequential phases.

#### Phase 1 — Bootstrap (one-time, idempotent)

Sets up the static reference data required by the daily simulation:

1. **SecurityBootstrap** — creates/verifies the admin user account
2. **SeederAuth.login()** — acquires a JWT token pair
3. **LocationBootstrap** — creates the shop location and service bays
4. **PeopleBootstrap** — creates employees (technicians, service writers, manager, parts clerk)
5. **CatalogBootstrap** — creates service and product catalog entities
6. **InventoryBootstrap** — seeds stock for catalog products at the location

All resulting IDs are stored in a `ReferenceCache` and passed to Phase 2.

#### Phase 2 — Daily Loop

Repeats for `SEEDER_DAYS` iterations. Each virtual day:

1. **Clock in** — employees are clocked in for the shift
2. **Customer events** — between `min` and `max` customers are simulated; each opens a work order, adds service/parts line items, processes payment, generates an invoice, and posts accounting entries
3. **Clock out** — shift is closed and time entries are approved
4. **Cycle count** — inventory cycle count runs every 7 days
5. **Monthly restock** — inventory restock runs every 30 days
6. **Token refresh** — JWT is refreshed automatically if within 60 seconds of expiry
7. **Sleep** — the process sleeps for `sleepBetweenDaysMs` before the next day

---

### Package Structure

```
src/
  index.ts                        # Entry point
  SeederAuth.ts                   # JWT login and token refresh
  SeederConfig.ts                 # Environment-based configuration
  bootstrap/
    BootstrapOrchestrator.ts      # Sequences all bootstrap steps
    SecurityBootstrap.ts
    LocationBootstrap.ts
    PeopleBootstrap.ts
    CatalogBootstrap.ts
    InventoryBootstrap.ts
  loop/
    DailyLoopRunner.ts            # Outer day-iteration loop
    CustomerEventSimulator.ts     # Per-customer workorder → invoice → accounting flow
    ShiftSimulator.ts             # Employee clock-in/out and time entry approval
    InventoryMaintenanceSimulator.ts  # Cycle counts and restocks
  support/
    ReferenceCache.ts             # Shared ID cache passed between phases
    CustomerPool.ts               # Reuses previously created customers
    SeederRandom.ts               # Seeded random number helper
```
