# Seeder Gateway Bug Analysis — "No instances available for api-gateway"

## Summary
When the seeder calls `createCommercialAccount` via the customer service, the backend fails with:
```
[WARN] No servers available for service: api-gateway
[ERROR] No instances available for api-gateway
java.lang.IllegalStateException: No instances available for api-gateway
```

This is caused by **service discovery misconfiguration** in the backend. The customer service tries to reach the people service and vehicle inventory service via hardcoded service names that don't exist.

---

## Root Cause Chain

### 1. **Seeder Call** → Customer Service
[packages/sdk-seeder/src/loop/CustomerEventSimulator.ts](packages/sdk-seeder/src/loop/CustomerEventSimulator.ts#L150)
```typescript
const customer = await this.customerClient.crmAccountsApi.createCommercialAccount({
  createCommercialAccountRequest: {
    legalName: `${firstName} ${lastName}`,
    displayName: `${firstName} ${lastName}`,
    partyType: 'PERSON',
    contactFirstName: firstName,
    contactLastName: lastName,
    email: this.random.email(firstName, lastName),
    phone: this.random.phone(),
  },
});
```
This calls HTTP `POST /v1/crm/accounts/parties`

---

### 2. **Backend Controller** → Service Layer
[C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\controller\CrmAccountsController.java](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\controller\CrmAccountsController.java#L158)
```java
@PostMapping("/parties")
@EmitEvent(id = "CUSTOMER_PARTY_CREATE", apiVersion = "1")
public ResponseEntity<CreateCommercialAccountResponse> createCommercialAccount(
        @RequestBody(required = false) CreateCommercialAccountRequest body) {
    log.info("createCommercialAccount");
    CreateCommercialAccountResponse response = partyService.createCommercialAccount(body);
    return ResponseEntity.status(HttpStatus.CREATED).body(response);
}
```

---

### 3. **PartyService → PeopleClient** ⚠️ **PROBLEM AREA #1**
[C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\service\PartyServiceImpl.java#L178-L195](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\service\PartyServiceImpl.java#L178-L195)
```java
private Contact buildContactForParty(CreateCommercialAccountRequest request, CommercialParty party) {
    // ... validation ...
    
    Contact contact = new Contact();
    UUID personId = peopleClient.resolveOrCreatePersonId(
        request.getEmail(),
        request.getPhone(),
        lastName,
        firstName
    );  // ← THIS CALL FAILS
    
    contact.setCommercialParty(party);
    contact.setPersonId(personId);
    // ... set other fields ...
    return contact;
}
```

---

### 4. **PeopleClient Configuration** ⚠️ **PROBLEM AREA #2**
[C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\PeopleClient.java#L25-L32](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\PeopleClient.java#L25-L32)
```java
public PeopleClient(
        @Qualifier("loadBalancedRestClientBuilder") RestClient.Builder restClientBuilder,
        @Value("${pos.people.base-url:http://api-gateway}") String peopleBaseUrl,  // ← DEFAULT IS http://api-gateway
        @Value("${pos.people.allow-local-fallback:false}") boolean allowLocalFallback) {
    this.restClient = restClientBuilder.baseUrl(peopleBaseUrl).build();
    log.info("PeopleClient initialized with baseUrl: {}", peopleBaseUrl);
}
```

**The Problem:**
- Uses `@Value("${pos.people.base-url:http://api-gateway}")` with default `http://api-gateway`
- If environment variable `pos.people.base-url` is **NOT** set, defaults to `http://api-gateway`
- Uses `loadBalancedRestClientBuilder` which tries to resolve `api-gateway` as a service name via Spring Cloud Load Balancer
- Service discovery fails because no service named `api-gateway` is registered

---

### 5. **Similar Problem in VehicleInventoryClient** ⚠️ **PROBLEM AREA #3**
[C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\VehicleInventoryClient.java#L28-L32](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\VehicleInventoryClient.java#L28-L32)
```java
public VehicleInventoryClient(
        @Qualifier("loadBalancedRestClientBuilder") RestClient.Builder restClientBuilder,
        @Value("${pos.vehicle-inventory.base-url:http://api-gateway}") String vehicleInventoryBaseUrl) {
    this.restClient = restClientBuilder.baseUrl(vehicleInventoryBaseUrl).build();
    log.info("VehicleInventoryClient initialized with baseUrl: {}", vehicleInventoryBaseUrl);
}
```

**Same issue** — if `pos.vehicle-inventory.base-url` is not set, defaults to `http://api-gateway`

---

## Why This Fails

### The Actual Problem Chain

1. **Missing Environment Variables in Docker Compose**  
   [C:\POS\durion-positivity-backend\docker-compose.yml#L296-L313](C:\POS\durion-positivity-backend\docker-compose.yml#L296-L313)  
   The `pos-customer` service does **NOT** set:
   - `pos.people.base-url`
   - `pos.vehicle-inventory.base-url`
   
   It only sets `GATEWAY_URL: http://pos-api-gateway:8080` and `EUREKA_CLIENT_SERVICEURL_DEFAULTZONE`

2. **Clients Default to Hardcoded `http://api-gateway`**  
   When env vars are missing, both clients use their `@Value` defaults:
   - `PeopleClient` → defaults to `http://api-gateway`
   - `VehicleInventoryClient` → defaults to `http://api-gateway`

3. **Load Balancer Tries Eureka Lookup**  
   The clients use `loadBalancedRestClientBuilder`, which:
   - Strips the `http://` protocol
   - Tries to resolve `api-gateway` as a **Eureka service name**
   - Spring Cloud Load Balancer queries Eureka for service instances

4. **Eureka Has No `api-gateway` Service Registration**  
   - The only gateway service is `pos-api-gateway` (registered in Eureka)
   - `api-gateway` is just a **Docker network alias** for `pos-api-gateway` (line 908)
   - Eureka doesn't know about network aliases — it only knows Eureka-registered services
   - Result: "No servers available for service: api-gateway"

5. **Connection Fails**  
   ```
   [WARN] No servers available for service: api-gateway
   [ERROR] No instances available for api-gateway
   java.lang.IllegalStateException: No instances available for api-gateway
   ```

---

## Solution Options

### Option A: Fix Docker Compose Environment Variables (RECOMMENDED)
Add the missing environment variables to the `pos-customer` service in docker-compose.yml:

**[C:\POS\durion-positivity-backend\docker-compose.yml](C:\POS\durion-positivity-backend\docker-compose.yml)** — Add to `pos-customer` environment section:
```yaml
pos-customer:
  environment:
    # ... existing vars ...
    pos.people.base-url: http://pos-people:8080
    pos.vehicle-inventory.base-url: http://pos-vehicle-inventory:8080
```

This tells the clients to call specific service URLs instead of trying to resolve `api-gateway` via Eureka.

### Option B: Fix Eureka Service Registration
Register `api-gateway` as a service name in the Eureka server with an alias pointing to `pos-api-gateway`.  
*(More complex; not recommended)*

### Option C: Change Backend Code Defaults
Update the client defaults to use direct service URLs instead of `http://api-gateway`:

**[PeopleClient.java](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\PeopleClient.java#L28)**
```java
@Value("${pos.people.base-url:http://pos-people:8080}")  // Changed default
```

**[VehicleInventoryClient.java](C:\POS\durion-positivity-backend\pos-customer\src\main\java\com\positivity\customer\internal\client\VehicleInventoryClient.java#L30)**
```java
@Value("${pos.vehicle-inventory.base-url:http://pos-vehicle-inventory:8080}")  // Changed default
```

---

## Problem Areas Summary

| File | Line | Issue | Impact |
|------|------|-------|--------|
| `pos-customer/.../PeopleClient.java` | 28 | Default base URL is `http://api-gateway` | Load balancer fails to resolve |
| `pos-customer/.../VehicleInventoryClient.java` | 30 | Default base URL is `http://api-gateway` | Load balancer fails to resolve |
| `pos-customer/.../PartyServiceImpl.java` | 195 | Calls `peopleClient.resolveOrCreatePersonId()` without proper service URL | Propagates the load balancer failure |
| `run-seeder.ps1` or backend env | — | Missing `pos.people.base-url` and `pos.vehicle-inventory.base-url` env vars | Clients fall back to broken defaults |

---

## Docker Compose Context

The `pos-api-gateway` service DOES exist and is properly configured:
```yaml
pos-api-gateway:
  build:
    context: ./pos-api-gateway
  ports:
    - "8080:8080"
  # ... registers with Eureka as "pos-api-gateway" service
  networks:
    pos-network:
      aliases:
        - api-gateway  # ← Docker network alias, but NOT an Eureka service name
```

**The Problem:**
- `api-gateway` is a **Docker network alias** (allows `curl http://api-gateway:8080` from other containers)
- It is NOT a **Eureka-registered service name** (which Spring Cloud Load Balancer needs)
- Spring Cloud Load Balancer only knows about services registered in Eureka, not Docker aliases

---

## Next Steps (Implementation)

### Immediate Fix (Recommended):
Edit [C:\POS\durion-positivity-backend\docker-compose.yml](C:\POS\durion-positivity-backend\docker-compose.yml#L302-L313) and add to `pos-customer` environment:
```yaml
pos-customer:
  environment:
    SPRING_PROFILES_ACTIVE: accelerated
    # ... existing vars ...
    pos.people.base-url: http://pos-people:8080              # ← ADD THIS
    pos.vehicle-inventory.base-url: http://pos-vehicle-inventory:8080  # ← ADD THIS
    <<: [ *pos-security-client-env, *pos-events-client-env ]
```

### Then Restart Containers:
```bash
cd C:\POS\durion-positivity-backend
docker compose down
docker compose up -d --build
```

### Finally Retest Seeder:
```bash
cd C:\POS\durion-positivity-sdk
.\run-seeder.ps1
```

---

## Why This Root Cause Matters

This is a **common microservices problem**: mixing Docker networking with Spring Cloud service discovery.
- Docker aliases work at the network level
- Eureka service names work at the application level
- Spring Cloud Load Balancer checks Eureka first, ignoring network aliases
- Solution: Always provide explicit service URLs via environment variables when mixing both approaches
