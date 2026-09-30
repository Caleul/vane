# Phase 7 generated-reference and performance evidence

The independent cases use the original tarball supplied to the conformance
runner. They install it with `npm install --ignore-scripts` in a fresh temporary
application, copy the official Sales/Billing declarations/configuration/demo
scripts, and use only the package's public exports and declared CLI. Temporary
PostgreSQL schemas and process/container names are unique to each case.

## Artifact provenance

`artifacts.json` version **2** explicitly changes content hashes to SHA-256 of the
final UTF-8 file bytes (version 1 hashed a JSON serialization of each string).
Each payload is linked to `<filename>.provenance.json`, schema version 1, containing
its input hash, generator package/version, IR versions, content hash and algorithm.
Source/SQL/Dockerfile comments link their companion. JSON IR shapes are unchanged,
including array-shaped contract IR. Companions must accompany standalone payloads.
The manifest hashes payloads and companions, and records its own provenance; it
intentionally does not claim a recursive self-hash. Docker images additionally
carry `org.vane.input-hash` and `org.vane.generator-version` labels, checked after
a real image build. Secret values are excluded from payloads and metadata.

## Reference and quickstart

The generated-bootstrap case executes the emitted bootstrap and configured ACL
adapter against real PostgreSQL and the example's local payment gateway. It
places an Order, observes its final Saga View, and reads PaymentReceipt. The
quickstart case literally executes the documented independent `npm init`, package
installation and `node quickstart.mjs` workflow. It does not substitute repository
implementation imports or handwritten domain handlers.

The Docker case is separate: `VANE_CONFORMANCE_DOCKER=1` requires a Linux Docker
CLI/daemon and performs the generated Dockerfile build, actual container start,
public reference flow and image-label inspection. Linux host networking lets the
container reach the test database and local gateway. Without that explicit test
environment it reports **GAP**, never inferred success. No image is published.

## Reproducible measurement boundaries

Each performance case records Node/platform/architecture/OS version, CPU model,
visible CPU count, available parallelism, memory, package version, tarball SHA-256,
reference source hashes, compiled input hash and raw millisecond samples.
These are measurements of the reported development/CI machine under nominal
load, not universal hardware or production guarantees.

- **Validate, ≤5 seconds:** three fresh Node processes run the installed CLI's
  `validate` over all three official reference profiles. Wall time includes Node
  startup and compilation. Every sample must satisfy the bound; installation and
  database setup are outside the measurement.
- **Dispatcher median, <10 ms:** the real public PostgreSQL Module runtime executes
  20 warm-up Events followed by 100 measured, sequential Events. Each sample is
  total dispatch wall time minus nonoverlapping awaited public pool `connect` and
  `query` durations. A guard rejects overlapping timing regions. Thus PostgreSQL,
  network and driver wait intervals are excluded, while residual framework/JS
  scheduling/instrumentation work remains. Total, excluded-I/O and residual raw
  samples are retained; a negative residual is an error, not clamped to zero.
- **Saga Stream, ≤1 second:** twenty real loopback SSE clients subscribe before a
  durable PostgreSQL terminal result is published. The monotonic start timestamp
  is immediately **before** `store.publish`; reception is the complete terminal
  frame. This is a conservative upper bound on post-persistence latency because
  it includes the persistence operation itself. Each frame and durable terminal
  state are checked; every sample must satisfy the bound. No in-memory store or
  simulated database stands in for terminal persistence.
