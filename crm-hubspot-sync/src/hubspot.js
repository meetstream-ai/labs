/**
 * Minimal HubSpot CRM client (built-in fetch, no SDK).
 *
 * Auth is a private app access token: https://developers.hubspot.com/docs/api/private-apps
 * Required scopes: crm.objects.contacts.read, crm.objects.deals.read,
 *                  crm.objects.notes.write (and crm.objects.notes.read to verify)
 *
 * Notes are "engagements" in HubSpot's UI. We create them on the v3 notes object
 * and associate them to the contact and, optionally, the contact's open deals.
 */

const HUBSPOT_API = "https://api.hubapi.com";

/**
 * HubSpot's default (HUBSPOT_DEFINED) association type IDs for a note.
 * https://developers.hubspot.com/docs/api/crm/associations
 */
export const NOTE_TO_CONTACT = 202;
export const NOTE_TO_COMPANY = 190;
export const NOTE_TO_DEAL = 214;

/** hs_note_body is capped at 65536 characters. */
export const NOTE_BODY_LIMIT = 65536;

export function assertHubSpotConfig() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    throw new Error(
      "HUBSPOT_ACCESS_TOKEN is required. Create a private app in HubSpot " +
        "(Settings > Integrations > Private Apps) and copy its access token."
    );
  }
}

async function hubspotRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(HUBSPOT_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (the private app is missing a scope - check crm.objects.contacts.read, crm.objects.deals.read and crm.objects.notes.write)"
        : "";
    throw new Error(
      `HubSpot ${res.status}: ${data?.message ?? res.statusText}${hint}` +
        (data?.correlationId ? ` [correlationId ${data.correlationId}]` : "")
    );
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Find a contact by exact email.
 * @returns {Promise<{ id: string, properties: object }|null>}
 */
export async function findContactByEmail(email) {
  const data = await hubspotRequest("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: String(email).toLowerCase() }] },
      ],
      properties: ["email", "firstname", "lastname", "company", "hs_object_id"],
      limit: 1,
    },
  });
  return data?.results?.[0] ?? null;
}

/** Display name for logging. */
export function contactLabel(contact) {
  const properties = contact?.properties ?? {};
  const name = [properties.firstname, properties.lastname].filter(Boolean).join(" ").trim();
  return name || properties.email || contact?.id || "unknown contact";
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

/** Deal IDs associated with a contact, via the v4 associations API. */
export async function getAssociatedDealIds(contactId) {
  const data = await hubspotRequest(
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/deals?limit=100`
  );
  return (data?.results ?? []).map((result) => result?.toObjectId).filter(Boolean).map(String);
}

/** Read a handful of useful deal properties. */
export async function getDeal(dealId) {
  const properties = ["dealname", "dealstage", "amount", "pipeline", "closedate"].join(",");
  return hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${properties}`);
}

/* ------------------------------------------------------------------ */
/* Notes (engagements)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create one note and associate it with every contact and deal we matched.
 *
 * @param {object} input
 * @param {string} input.body           HTML body for hs_note_body
 * @param {string[]} input.contactIds
 * @param {string[]} [input.dealIds]
 * @param {Date} [input.timestamp]
 * @returns {Promise<{ id: string }>}
 */
export async function createNote({ body, contactIds = [], dealIds = [], timestamp = new Date() }) {
  if (contactIds.length === 0 && dealIds.length === 0) {
    throw new Error("createNote: nothing to associate the note with.");
  }

  const associations = [
    ...contactIds.map((id) => association(id, NOTE_TO_CONTACT)),
    ...dealIds.map((id) => association(id, NOTE_TO_DEAL)),
  ];

  let noteBody = String(body ?? "");
  if (noteBody.length > NOTE_BODY_LIMIT) {
    noteBody = `${noteBody.slice(0, NOTE_BODY_LIMIT - 60)}\n<p><em>[truncated]</em></p>`;
  }

  return hubspotRequest("/crm/v3/objects/notes", {
    method: "POST",
    body: {
      properties: {
        hs_note_body: noteBody,
        // hs_timestamp is required. Milliseconds since epoch or ISO 8601.
        hs_timestamp: timestamp.toISOString(),
      },
      associations,
    },
  });
}

function association(toId, associationTypeId) {
  return {
    to: { id: String(toId) },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
  };
}

/** Link to the note in the HubSpot UI, when the portal ID is known. */
export function noteUrl(noteId) {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  return portalId
    ? `https://app.hubspot.com/contacts/${portalId}/objects/0-46/${noteId}`
    : `note ${noteId}`;
}
