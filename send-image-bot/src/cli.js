/**
 * Argument parsing and image-URL validation.
 */

export const USAGE = `
send-image-bot: put an image or animated GIF into a meeting

  Chat mode (default). Post an image into the meeting chat over REST:
    node index.js --bot-id <id> --img-url https://example.com/chart.png
    node index.js --bot-id <id> --img-url https://example.com/wave.gif --display-duration 8

  Video-frame mode. Make the image the bot's camera feed over the control socket:
    node index.js --mode video-frame --meeting-link https://meet.google.com/abc-defg-hij \\
      --img-url https://example.com/avatar.png

  Slideshow on the bot's camera feed (cycles every --interval seconds):
    node index.js --mode video-frame --meeting-link <url> \\
      --img-url https://example.com/slide1.png \\
      --img-url https://example.com/slide2.png --interval 15

  Local file as the camera feed (base64 over the socket, no hosting needed):
    node index.js --mode video-frame --meeting-link <url> --img-file ./logo.png

Options
  --mode <chat|video-frame>  Default chat
  --bot-id <id>              Chat mode: the bot to post through
  --meeting-link <url>       Video-frame mode: meeting to send a new bot into
  --bot-name <name>          Display name for a newly created bot
  --img-url <url>            Public image URL. Repeatable in video-frame mode.
  --img-file <path>          Video-frame mode only: local image sent as base64
  --display-duration <secs>  Chat mode only: how long the image is displayed
  --interval <secs>          Video-frame slideshow interval (default 10)
  --duration <secs>          Video-frame mode: run for this long, then remove the bot
  --dry-run                  Validate inputs and print the plan, call nothing
  -h, --help                 This text

IMPORTANT: --img-url must be a PUBLIC URL. POST /bots/{id}/send_image takes
img_url only: there is no base64 body for it, and localhost or data: URLs
cannot be fetched by MeetStream's servers.
`;

export function parseArgs(argv) {
  const opts = {
    mode: "chat",
    botId: null,
    meetingLink: null,
    botName: process.env.BOT_NAME || "MeetStream Labs Image Bot",
    imgUrls: [],
    imgFile: null,
    displayDuration: undefined,
    interval: 10,
    duration: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };

    switch (arg) {
      case "--mode":              opts.mode = value(); break;
      case "--bot-id":            opts.botId = value(); break;
      case "--meeting-link":      opts.meetingLink = value(); break;
      case "--bot-name":          opts.botName = value(); break;
      case "--img-url":           opts.imgUrls.push(value()); break;
      case "--img-file":          opts.imgFile = value(); break;
      case "--display-duration":  opts.displayDuration = positive(arg, value()); break;
      case "--interval":          opts.interval = positive(arg, value()); break;
      case "--duration":          opts.duration = positive(arg, value()); break;
      case "--dry-run":           opts.dryRun = true; break;
      case "-h":
      case "--help":              opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function positive(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number (got "${raw}")`);
  return n;
}

/**
 * The single most common failure with send_image is handing it something
 * MeetStream's servers cannot fetch. Catch that here rather than at HTTP 400.
 */
export function assertPublicImageUrl(raw) {
  const value = String(raw).trim();

  if (value.startsWith("data:")) {
    throw new Error(
      "img_url cannot be a data: URI. POST /bots/{id}/send_image fetches the URL " +
      "server-side: there is no base64 form of this endpoint. Host the image somewhere " +
      "public (S3, Cloudinary, your CDN, a GitHub raw URL) and pass that link."
    );
  }

  if (value.startsWith("file:") || value.startsWith("/") || value.startsWith("./")) {
    throw new Error(
      `img_url must be a URL, not a local path ("${value}"). MeetStream fetches the image ` +
      "from its own servers, so the file has to be publicly hosted."
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`img_url is not a valid URL: "${value}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`img_url must be http(s). Got protocol "${url.protocol}".`);
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) {
    throw new Error(
      `img_url points at a private address ("${host}"). MeetStream fetches the image from ` +
      "the public internet and cannot reach your machine or LAN. Use a hosted URL, or " +
      "expose the file through a tunnel."
    );
  }

  return { url: value, warnHttp: url.protocol === "http:" };
}

export function validate(opts) {
  if (opts.mode !== "chat" && opts.mode !== "video-frame") {
    throw new Error(`--mode must be "chat" or "video-frame" (got "${opts.mode}")`);
  }

  if (opts.mode === "chat") {
    if (!opts.botId) throw new Error("Chat mode needs --bot-id.");
    if (opts.meetingLink) throw new Error("--meeting-link only applies to --mode video-frame.");
    if (opts.imgFile) {
      throw new Error(
        "--img-file only applies to --mode video-frame. The chat endpoint takes img_url " +
        "and fetches it server-side, so a local file has to be hosted first."
      );
    }
    if (opts.imgUrls.length !== 1) {
      throw new Error("Chat mode needs exactly one --img-url.");
    }
  } else {
    if (!opts.meetingLink) {
      throw new Error(
        "Video-frame mode needs --meeting-link. The bot only opens a control socket if it " +
        "was created with socket_connection_url, so this mode creates its own bot."
      );
    }
    if (opts.botId) {
      throw new Error(
        "--bot-id cannot be used with --mode video-frame. An existing bot has no control " +
        "socket unless it was created with one."
      );
    }
    if (opts.imgUrls.length === 0 && !opts.imgFile) {
      throw new Error("Video-frame mode needs at least one --img-url, or an --img-file.");
    }
    if (opts.displayDuration !== undefined) {
      throw new Error("--display-duration is a chat-mode option (send_image), not a video-frame one.");
    }
  }
}
