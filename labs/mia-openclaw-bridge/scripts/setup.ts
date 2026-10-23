import { createEnvFile } from "../src/config.js";

const created = await createEnvFile();
if (created) {
  console.log("Created .env from .env.example.");
  console.log("Add your MeetStream key, ngrok token, OpenClaw Gateway URL/token, and meeting URL, then run npm start.");
} else {
  console.log("Kept your existing .env unchanged.");
}
