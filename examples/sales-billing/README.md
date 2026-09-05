# Sales/Billing reference

Node 24 and PostgreSQL 16+ are required. From the repository root:

```sh
npm ci
npm run build
export DATABASE_URL=postgresql://vane:vane@localhost:5432/vane
export PAYMENT_GATEWAY_URL=http://127.0.0.1:4000
node dist/cli.js validate --config examples/sales-billing/configuration.mjs --json
node dist/cli.js migrate diff --config examples/sales-billing/configuration.mjs --profile development --json > /tmp/vane-initial.json
node dist/cli.js migrate apply --config examples/sales-billing/configuration.mjs --profile development --migration /tmp/vane-initial.json
```

Start the local external-system stand-in in another terminal:

```sh
node examples/sales-billing/gateway.mjs
```

Start the application:

```sh
node dist/cli.js dev --config examples/sales-billing/configuration.mjs --profile development --port 3000
```

Invoke `Order.Place` (use a new UUID for each new order):

```sh
curl -s http://127.0.0.1:3000/sales/events/Order.Place \
  -H 'Content-Type: application/json' \
  -d '{"id":"e831af7b-52d9-41e7-84c8-4a30774c2e8d","amount":500,"minimum":100}'
```

The response is `202` with `sagaId`. Open the generated terminal stream path
(`/sales/sagas/<sagaId>` as listed in the plan/OpenAPI). It returns only
`OrderDetails` or a safe terminal fail. Query `PaymentReceipt` with POST
`/billing/views/PaymentReceipt` and `{"id":"<order UUID>"}`.

The Modules contain no controllers, repositories or handwritten domain handlers.
Sales owns Order and imports Billing, which owns Payment and PaymentGateway.
PlaceOrder orders `Order.Place → Payment.Create → PaymentGateway.Authorize →
Order.Complete`. Failed authorization compensates Payment and Order. The
`amount >= minimum` Rule involves two Columns and is enforced by PostgreSQL.

`test` changes telemetry without changing semantics. `production` requires
API_TOKEN bearer authentication, a quota and symbolic secret bindings; `dev`
refuses production. Generate deployment artifacts for that profile explicitly.
The mock gateway stores idempotency receipts in memory and is only a local demo;
production gateways must honor the Event identity for the full recovery horizon.

Stopping with SIGINT/SIGTERM drains active workers; restarting resumes persisted
work. Stop the gateway to exercise retry and failure inspection. See the
[operations guide](../../docs/operations.md) for commands and guarantees.
