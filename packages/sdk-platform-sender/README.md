## @durion-sdk/platform-sender

TypeScript (fetch) client for the `pos-platform-sender` **device registration API**
(ADR-0076): register or refresh a technician-app push installation, and remove it on
sign-out.

- Generated from `durion-positivity-backend/pos-platform-sender/openapi-public.yaml`,
  the device-only document. The shared-secret send API (`/platform-sender/v1/messages`)
  is service-to-service only and never reaches this package (#3454; enforced by the
  backend's `scripts/ci/check-public-openapi-leaks.py`).
- The generated paths carry `/platform-sender/v1/...` and the gateway route has no
  StripPrefix, so pass the **gateway root** as `baseUrl`.

```ts
import { createPlatformSenderClient } from '@durion-sdk/platform-sender';

const client = createPlatformSenderClient({ baseUrl: 'https://gateway.example', token: () => jwt });
await client.platformSenderDevicesApi.registerPushDevice({ /* RegisterPushDeviceRequest */ });
```

`src/apis/**`, `src/models/**` and `src/runtime.ts` are generator-owned; `src/index.ts`,
this README, `package.json` and the tsconfigs are hand-maintained (see
`.openapi-generator-ignore`).
