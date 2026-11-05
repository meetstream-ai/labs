import { loadLocalConfig } from "../src/config.js";

const { env: local, input: payload, warnings } = await loadLocalConfig(process.argv[2]);
for (const warning of warnings) console.warn(`Warning: ${warning}`);

const response = await fetch("http://127.0.0.1:3000/v1/meeting-sessions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(local.BRIDGE_API_KEY || local.MIA_HERMES_API_KEY
      ? { "X-Integration-Key": local.BRIDGE_API_KEY || local.MIA_HERMES_API_KEY }
      : {})
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(45_000)
});
const body = await response.text();
if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}: ${body}`);
console.log(JSON.stringify(JSON.parse(body), null, 2));
