import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type Item = { request?: Request; originalRequest?: Request; response?: Item[]; item?: Item[] };
type Request = { method?: string; url?: { raw?: string } };

const path = process.argv[2] ?? "/Users/arjun/Downloads/Meetstream.postman_collection.json";
const raw = await readFile(path);
const collection = JSON.parse(raw.toString()) as { item?: Item[] };
const found = new Set<string>();

function walk(items: Item[] = []): void {
  for (const item of items) {
    for (const request of [item.request, item.originalRequest]) {
      if (request) found.add(`${request.method ?? ""} ${request.url?.raw ?? ""}`);
    }
    walk(item.response);
    walk(item.item);
  }
}

walk(collection.item);
for (const required of [
  "POST {{baseUrl}}/api/v1/bots/create_bot",
  "GET {{baseUrl}}/api/v1/bots/{{bot_id}}/remove_bot",
  "POST {{baseUrl}}/api/v1/bots/{{bot_id}}/send_message",
  "GET {{baseUrl}}/api/v1/mia",
  "POST {{baseUrl}}/api/v1/mia",
  "PUT {{baseUrl}}/api/v1/mia"
]) {
  if (!found.has(required)) throw new Error(`Missing Postman request: ${required}`);
}
console.log(`OK sha256=${createHash("sha256").update(raw).digest("hex")} requests=${found.size}`);
