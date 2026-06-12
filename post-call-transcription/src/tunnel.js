const ngrok = require("@ngrok/ngrok");

/**
 * Starts an ngrok tunnel on the given port and returns the public HTTPS URL.
 *
 * Requires NGROK_AUTHTOKEN in .env — free at https://dashboard.ngrok.com
 *
 * @param {number} port  Local port to expose
 * @returns {Promise<string>}  Public HTTPS URL e.g. "https://abc123.ngrok-free.app"
 */
async function startTunnel(port) {
  if (!process.env.NGROK_AUTHTOKEN) {
    console.error("  NGROK_AUTHTOKEN is not set in your .env file.");
    console.error(
      "   Get a free token at: https://dashboard.ngrok.com/get-started/your-authtoken"
    );
    process.exit(1);
  }

  console.log("  Starting ngrok tunnel...");

  const listener = await ngrok.forward({
    addr: port,
    authtoken: process.env.NGROK_AUTHTOKEN,
  });

  const url = listener.url();
  console.log(`   Tunnel live → ${url}\n`);
  return url;
}

module.exports = { startTunnel };
