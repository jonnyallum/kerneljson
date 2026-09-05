// Loopback-only synthetic preview, never imported by a production entry point.
import { createServer } from "node:http";
import { knowledgeDatabase } from "./knowledge-db.js";
import { createMissionControl } from "../../apps/mission-control/src/server.js";
import { MissionControlStore } from "../../apps/mission-control/src/store.js";
const db = await knowledgeDatabase();
const handler = createMissionControl({
  store: new MissionControlStore(db.pool),
  origin: "http://127.0.0.1:19090",
  authenticate: async () => db.context,
});
const server = createServer((req, res) => {
  void handler(req, res);
});
server.listen(19090, "127.0.0.1", () =>
  console.log("Synthetic preview: http://127.0.0.1:19090"),
);
const stop = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (String(data).includes("stop")) void stop();
});
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
