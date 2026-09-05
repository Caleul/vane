// Local stand-in for the external payment system; not application domain code.
import { createServer } from "node:http";
const receipts = new Map();
const server = createServer((request, response) => {
  const key = request.headers["idempotency-key"];
  if (!key) {
    response.writeHead(400);
    response.end();
    return;
  }
  const receipt = receipts.get(key) ?? { reference: `authorization-${key}` };
  receipts.set(key, receipt);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(receipt));
});
server.listen(4000, "127.0.0.1");
const stop = () => {
  server.close();
  server.closeAllConnections();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
