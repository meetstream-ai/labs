/**
 * CRM HubSpot Sync
 *
 * After a sales call, attach the MeetStream summary, action items and transcript
 * to the matching HubSpot contact and their open deals as a note (engagement).
 *
 *   node index.js --meeting "https://us02web.zoom.us/j/123456789" --emails "buyer@acme.com"
 *   node index.js --bot <bot_id> --emails "buyer@acme.com,champion@acme.com"
 */

import "dotenv/config";

import { parseArgs, run } from "./src/pipeline.js";
import {
  getBotSummary,
  getParticipants,
  normalizeParticipants,
  summaryToText,
} from "./src/meetstream.js";
import {
  assertHubSpotConfig,
  contactLabel,
  createNote,
  findContactByEmail,
  getAssociatedDealIds,
  getDeal,
  noteUrl,
} from "./src/hubspot.js";
import { buildNoteBody } from "./src/note.js";
import { extractActionItems } from "./src/actions.js";
import { describeLlm } from "./src/llm.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails from --emails, ATTENDEE_EMAILS, and whatever the platform reported. */
function collectEmails(participants) {
  const args = parseArgs();
  const raw = [
    ...String(args.emails || "").split(","),
    ...String(process.env.ATTENDEE_EMAILS || "").split(","),
    ...participants.map((person) => person.email ?? ""),
  ];

  const emails = new Set();
  for (const value of raw) {
    const email = value.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) continue;
    if (isExcludedDomain(email)) continue;
    emails.add(email);
  }
  return [...emails];
}

/** Skip your own team so you do not log the note against internal contacts. */
function isExcludedDomain(email) {
  const excluded = String(process.env.EXCLUDE_EMAIL_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const domain = email.split("@")[1];
  return excluded.includes(domain);
}

run({
  name: "CRM HubSpot Sync",

  preflight() {
    assertHubSpotConfig();
    console.log(`LLM for action items: ${describeLlm()}`);
  },

  async onMeetingComplete({ botId, transcriptId, segments }) {
    /* 1. MeetStream's AI summary. */
    let summary = "";
    if (botId) {
      const payload = await getBotSummary(botId);
      if (payload) summary = summaryToText(payload);
      else console.warn("  GET /bots/{id}/summary returned 202, the summary is still generating.");
    }

    /* 2. Participants. Zoom, Meet and Teams do not always expose emails, which is
          why --emails / ATTENDEE_EMAILS exists as the reliable path. */
    let participants = [];
    if (botId) {
      try {
        participants = normalizeParticipants(await getParticipants(botId));
      } catch (error) {
        console.warn(`  Could not read participants: ${error.message}`);
      }
    }

    const emails = collectEmails(participants);
    if (emails.length === 0) {
      throw new Error(
        "No attendee emails to match on. The meeting platform did not report any, so pass them " +
          'explicitly: node index.js --bot <id> --emails "buyer@acme.com"'
      );
    }
    console.log(`Matching on: ${emails.join(", ")}`);

    /* 3. Look up the contacts. */
    const contactIds = [];
    for (const email of emails) {
      const contact = await findContactByEmail(email);
      if (!contact) {
        console.warn(`  No HubSpot contact found for ${email}. Skipping.`);
        continue;
      }
      console.log(`  Matched ${email} to contact ${contact.id} (${contactLabel(contact)})`);
      contactIds.push(contact.id);
    }

    if (contactIds.length === 0) {
      throw new Error(
        "None of the attendee emails matched a HubSpot contact. Create the contact first, " +
          "or pass an email that exists in your portal."
      );
    }

    /* 4. Their deals. */
    const dealIds = new Set();
    if (process.env.ATTACH_TO_DEALS !== "false") {
      for (const contactId of contactIds) {
        try {
          for (const dealId of await getAssociatedDealIds(contactId)) dealIds.add(dealId);
        } catch (error) {
          console.warn(`  Could not read deals for contact ${contactId}: ${error.message}`);
        }
      }
      for (const dealId of dealIds) {
        try {
          const deal = await getDeal(dealId);
          console.log(
            `  Deal ${dealId}: ${deal?.properties?.dealname ?? "(unnamed)"} ` +
              `[${deal?.properties?.dealstage ?? "no stage"}]`
          );
        } catch (error) {
          console.warn(`  Could not read deal ${dealId}: ${error.message}`);
        }
      }
    }

    /* 5. Action items (optional, needs an LLM key). */
    let actionItems = [];
    try {
      actionItems = await extractActionItems(segments, summary);
      console.log(`Extracted ${actionItems.length} action items.`);
    } catch (error) {
      console.warn(`  Action item extraction failed, logging without it: ${error.message}`);
    }

    /* 6. One note, associated with every matched contact and deal. */
    const title = (process.env.NOTE_TITLE || "Meeting notes - {date}").replace(
      "{date}",
      new Date().toLocaleDateString("en-US", { dateStyle: "medium" })
    );

    const body = buildNoteBody({
      title,
      summary,
      actionItems,
      participants: participants.map((person) => person.name || person.email).filter(Boolean),
      segments,
      botId,
      transcriptId,
      includeTranscript: process.env.INCLUDE_TRANSCRIPT !== "false",
      maxTurns: Number(process.env.NOTE_MAX_TRANSCRIPT_TURNS || 200),
    });

    const note = await createNote({ body, contactIds, dealIds: [...dealIds] });
    console.log(
      `Logged note ${note.id} on ${contactIds.length} contact(s) and ${dealIds.size} deal(s).`
    );
    console.log(noteUrl(note.id));
  },
}).catch((error) => {
  console.error(`\n  ${error.message}`);
  process.exit(1);
});
