import assert from "node:assert/strict";

export const cases = [
  {
    id: "operations.configured-redaction",
    requirements: ["EE-OBS-006"],
    kind: "positive",
    run: async ({ api }) => {
      const records = [];
      const telemetry = new api.RuntimeTelemetry(
        { exporter: "json", redact: ["customerEmail"] },
        (r) => records.push(r),
      );
      const secret = "CF_SENTINEL_NOT_A_REAL_SECRET";
      const value = {
        eventIdentity: "Booking.Reserve",
        correlationId: "test-correlation",
        CustomerEmail: secret,
        nested: { password: secret, TOKEN: secret },
        entries: [{ authorization: secret, payload: { value: secret } }],
      };
      telemetry.record("event", value, "success", 4);
      assert.equal(records.length, 1);
      assert.equal(records[0].schema, "vane.telemetry");
      assert.equal(records[0].attributes.eventIdentity, "Booking.Reserve");
      assert.equal(records[0].attributes.correlationId, "test-correlation");
      assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
      assert.equal(records[0].attributes.CustomerEmail, "[REDACTED]");
      assert.equal(records[0].attributes.nested.TOKEN, "[REDACTED]");
      assert.deepEqual(telemetry.metrics()["event.success"], {
        count: 1,
        durationMs: 4,
      });
      const broken = new api.RuntimeTelemetry({ exporter: "json" }, () =>
        Promise.reject(new Error("controlled sink failure")),
      );
      assert.equal(await broken.span("event", {}, async () => 42), 42);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(broken.exporterFailures, 1);
      return "Configured case-insensitive sensitive keys, default credentials and payloads redact recursively in emitted JSON while causal metadata survives; rejected exporter cannot change work result";
    },
  },
];
