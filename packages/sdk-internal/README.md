## SDK Internal Package

**INTERNAL ONLY** - `@durion-sdk/internal`

This package is classified as internal-only under [ADR-0021](../../docs/adr/0021-tax-api-consumption-and-internal-access-policy.adr.md).

It provides access to internal platform services (currently: Tax Service) and MUST NOT be:

- Re-exported from any public `@durion-sdk/*` package
- Consumed by external clients
- Listed in the public SDK documentation

### Usage (internal services only)

```typescript
import { createTaxClient } from '@durion-sdk/internal';

const taxClient = createTaxClient({ baseUrl: 'http://pos-tax:8086' });
const result = await taxClient.taxApi.calculateTax({
  taxCalculationRequest: { /* ... */ }
});
```

### ADR-0021 Compliance

All consumers must handle `400 Bad Request` responses as deterministic data quality errors.
Do not retry `400` responses automatically.
See ADR-0021 for full compliance requirements.
