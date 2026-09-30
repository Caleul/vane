# Sales/Billing reference

Node 24 and PostgreSQL 16+ are required. First build and pack Vane from the
repository root (`npm ci && npm run build && npm pack`), or use a supplied
Vane tarball. Set `VANE_TARBALL` to its absolute path and `DATABASE_URL` to your
PostgreSQL connection. The demo schema defaults to `sales_billing`; choose a
fresh `VANE_NAMESPACE` to keep it isolated.

Run these commands from the repository root to install the public package in a
separate application directory and execute the complete quickstart:

```sh
mkdir -p /tmp/vane-reference
cp examples/sales-billing/*.mjs examples/sales-billing/*.ts /tmp/vane-reference/
cd /tmp/vane-reference
npm init -y
npm install --ignore-scripts "$VANE_TARBALL"
node quickstart.mjs
```

The script validates the installed-package configuration, starts the local
payment gateway, generates/applies the initial migration, starts `entity-event
dev`, places an Order, reads its terminal Saga Stream and queries PaymentReceipt.
It prints one JSON result and shuts down both processes. Rows remain in the
selected demo schema for inspection. It contains no application domain handlers.

For a long-running application, use the equivalent manual commands from that
installed example directory:

```sh
export PAYMENT_GATEWAY_URL=http://127.0.0.1:4000
npx --no-install entity-event validate --config configuration.mjs --json
npx --no-install entity-event migrate diff --config configuration.mjs --profile development --json > /tmp/vane-initial.json
npx --no-install entity-event migrate apply --config configuration.mjs --profile development --migration /tmp/vane-initial.json
```

Start the local external-system stand-in in another terminal:

```sh
node gateway.mjs
```

Start the application:

```sh
npx --no-install entity-event dev --config configuration.mjs --profile development --port 3000
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
[operations guide](https://github.com/Caleul/vane/blob/main/docs/operations.md) for commands and guarantees.

The profile also records a design-only future allocation to `sales-api` and
`billing-api` sharing the symbolic database `shared-commerce`. This is visible in
the Runtime IR; the generated application still runs one monolithic service.
