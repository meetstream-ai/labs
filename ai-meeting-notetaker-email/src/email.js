/**
 * Pluggable email sending - Resend, SendGrid, or plain SMTP.
 *
 * Pick one with EMAIL_PROVIDER:
 *
 *   resend    RESEND_API_KEY                             (HTTPS, no SDK)
 *   sendgrid  SENDGRID_API_KEY                           (HTTPS, no SDK)
 *   smtp      SMTP_HOST / SMTP_PORT / SMTP_USER /
 *             SMTP_PASS / SMTP_SECURE                    (uses nodemailer)
 *   console   nothing - prints the email instead of sending it (great for testing)
 *
 * Every provider takes the same `{ from, to, subject, html, text }` and returns
 * a short human-readable description of what happened.
 */

const PROVIDERS = new Set(["resend", "sendgrid", "smtp", "console"]);

export function resolveEmailProvider() {
  const provider = (process.env.EMAIL_PROVIDER || "console").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown EMAIL_PROVIDER "${provider}". Use one of: ${[...PROVIDERS].join(", ")}.`
    );
  }
  return provider;
}

/** Validate provider config up front so we fail before creating a bot. */
export function assertEmailConfig() {
  const provider = resolveEmailProvider();
  const need = (name) => {
    if (!process.env[name]) {
      throw new Error(`EMAIL_PROVIDER=${provider} requires ${name} to be set.`);
    }
  };

  if (provider !== "console" && !process.env.EMAIL_FROM) {
    throw new Error(`EMAIL_PROVIDER=${provider} requires EMAIL_FROM (e.g. "Notes <notes@yourdomain.com>").`);
  }

  if (provider === "resend") need("RESEND_API_KEY");
  if (provider === "sendgrid") need("SENDGRID_API_KEY");
  if (provider === "smtp") {
    need("SMTP_HOST");
    need("SMTP_USER");
    need("SMTP_PASS");
  }
  return provider;
}

/**
 * @param {object} message
 * @param {string[]} message.to
 * @param {string} message.subject
 * @param {string} message.html
 * @param {string} message.text
 * @returns {Promise<string>} description of the send
 */
export async function sendEmail({ to, subject, html, text }) {
  const provider = resolveEmailProvider();
  const from = process.env.EMAIL_FROM || "meetstream-labs@example.com";
  const recipients = [...new Set((to || []).map((address) => String(address).trim()).filter(Boolean))];

  if (recipients.length === 0) {
    throw new Error("No recipients. Set EMAIL_TO, or enable SEND_TO_PARTICIPANTS=true.");
  }

  switch (provider) {
    case "resend":
      return sendWithResend({ from, recipients, subject, html, text });
    case "sendgrid":
      return sendWithSendGrid({ from, recipients, subject, html, text });
    case "smtp":
      return sendWithSmtp({ from, recipients, subject, html, text });
    default:
      return sendToConsole({ from, recipients, subject, text });
  }
}

/* ------------------------------------------------------------------ */

async function sendWithResend({ from, recipients, subject, html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: recipients, subject, html, text }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${data?.message || res.statusText}`);
  }
  return `Resend accepted the email (id ${data?.id ?? "unknown"}) for ${recipients.join(", ")}`;
}

async function sendWithSendGrid({ from, recipients, subject, html, text }) {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: recipients.map((email) => ({ email })) }],
      from: parseAddress(from),
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SendGrid ${res.status}: ${body || res.statusText}`);
  }
  // SendGrid returns 202 Accepted with an empty body on success.
  return `SendGrid accepted the email for ${recipients.join(", ")}`;
}

async function sendWithSmtp({ from, recipients, subject, html, text }) {
  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch {
    throw new Error("EMAIL_PROVIDER=smtp needs nodemailer. Run: npm install nodemailer");
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Implicit TLS on 465, STARTTLS everywhere else.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const info = await transporter.sendMail({
    from,
    to: recipients.join(", "),
    subject,
    text,
    html,
  });

  return `SMTP delivered the email (${info.messageId}) to ${recipients.join(", ")}`;
}

function sendToConsole({ from, recipients, subject, text }) {
  console.log("\n" + "-".repeat(70));
  console.log("EMAIL_PROVIDER=console - printing instead of sending");
  console.log("-".repeat(70));
  console.log(`From:    ${from}`);
  console.log(`To:      ${recipients.join(", ")}`);
  console.log(`Subject: ${subject}\n`);
  console.log(text);
  console.log("-".repeat(70) + "\n");
  return `Printed the email to stdout for ${recipients.join(", ")}`;
}

/** "Name <a@b.com>" → { email, name }; "a@b.com" → { email }. */
function parseAddress(value) {
  const match = String(value).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { email: match[2], name: match[1] || undefined };
  return { email: String(value).trim() };
}
