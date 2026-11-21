async function startTunnel(port) {
  const authtoken = process.env.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) return undefined;

  const ngrok = require("@ngrok/ngrok");
  console.log("Starting ngrok tunnel...");

  const listener = await ngrok.forward({ addr: port, authtoken });
  const url = listener.url();

  console.log(`  public URL: ${url}`);
  return {
    url,
    close: () => listener.close(),
  };
}

module.exports = { startTunnel };
