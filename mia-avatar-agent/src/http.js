export async function request(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(
      `${method} ${url} -> ${res.status} ${res.statusText}: ${JSON.stringify(data)}`
    );
    error.status = res.status;
    error.body = data;
    throw error;
  }

  return data;
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}
