/**
 * Minimal Notion API client (built-in fetch, no SDK).
 *
 * Docs: https://developers.notion.com/reference/intro
 *
 * Two limits drive most of the code here:
 *   - a single rich_text object holds at most 2000 characters
 *   - a single request appends at most 100 child blocks
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const RICH_TEXT_LIMIT = 2000;
const CHILDREN_PER_REQUEST = 100;

export function assertNotionConfig() {
  if (!process.env.NOTION_API_KEY) {
    throw new Error(
      "NOTION_API_KEY is required. Create an internal integration at " +
        "https://www.notion.so/my-integrations and copy the secret."
    );
  }
  if (!process.env.NOTION_DATABASE_ID && !process.env.NOTION_PARENT_PAGE_ID) {
    throw new Error(
      "Set NOTION_DATABASE_ID (recommended) or NOTION_PARENT_PAGE_ID so we know where to file the notes."
    );
  }
  if (process.env.NOTION_DATABASE_ID && process.env.NOTION_PARENT_PAGE_ID) {
    console.warn("  Both NOTION_DATABASE_ID and NOTION_PARENT_PAGE_ID are set. Using the database.");
  }
}

async function notionRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(NOTION_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " (share the database or page with your integration: Connections menu in Notion)"
        : "";
    throw new Error(`Notion ${res.status} ${data?.code ?? ""}: ${data?.message ?? res.statusText}${hint}`);
  }
  return data;
}

/** Notion accepts dashed or undashed 32-char IDs. Strip anything else people paste in. */
export function normalizeNotionId(value) {
  const raw = String(value ?? "").trim();
  const fromUrl = raw.match(/([0-9a-fA-F]{32})/);
  if (fromUrl) return fromUrl[1];
  return raw.replace(/^.*\//, "").split("?")[0];
}

/* ------------------------------------------------------------------ */
/* Rich text + blocks                                                  */
/* ------------------------------------------------------------------ */

/** Split long strings across multiple rich_text objects so nothing is dropped. */
export function richText(content, annotations) {
  const text = String(content ?? "");
  if (text.length === 0) return [];
  const parts = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    parts.push({
      type: "text",
      text: { content: text.slice(i, i + RICH_TEXT_LIMIT) },
      ...(annotations ? { annotations } : {}),
    });
  }
  return parts;
}

export const heading = (text) => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: richText(text) },
});

export const paragraph = (text) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: richText(text) },
});

export const bullet = (text) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: richText(text) },
});

export const todo = (text, checked = false) => ({
  object: "block",
  type: "to_do",
  to_do: { rich_text: richText(text), checked },
});

export const divider = () => ({ object: "block", type: "divider", divider: {} });

export const callout = (text, emoji = "🎙️") => ({
  object: "block",
  type: "callout",
  callout: { rich_text: richText(text), icon: { type: "emoji", emoji } },
});

/** A collapsed toggle. Notion allows at most 100 children inline, so we cap. */
export const toggle = (text, children = []) => ({
  object: "block",
  type: "toggle",
  toggle: { rich_text: richText(text), children: children.slice(0, CHILDREN_PER_REQUEST) },
});

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Find the name of a database's title property. It is not always called "Name". */
async function getDatabaseTitleProperty(databaseId) {
  const database = await notionRequest(`/databases/${databaseId}`);
  const entry = Object.entries(database.properties || {}).find(
    ([, property]) => property?.type === "title"
  );
  if (!entry) throw new Error(`Notion database ${databaseId} has no title property.`);
  return { titleProperty: entry[0], properties: database.properties || {} };
}

/**
 * Create the meeting page and append every block.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {Array}  input.blocks
 * @param {string} [input.isoDate]  Written into NOTION_DATE_PROPERTY when that property exists
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function createMeetingPage({ title, blocks, isoDate }) {
  const databaseId = process.env.NOTION_DATABASE_ID
    ? normalizeNotionId(process.env.NOTION_DATABASE_ID)
    : null;
  const parentPageId = process.env.NOTION_PARENT_PAGE_ID
    ? normalizeNotionId(process.env.NOTION_PARENT_PAGE_ID)
    : null;

  let parent;
  let properties;

  if (databaseId) {
    const { titleProperty, properties: schema } = await getDatabaseTitleProperty(databaseId);
    parent = { database_id: databaseId };
    properties = { [titleProperty]: { title: richText(title) } };

    const dateProperty = process.env.NOTION_DATE_PROPERTY;
    if (dateProperty && schema[dateProperty]?.type === "date" && isoDate) {
      properties[dateProperty] = { date: { start: isoDate } };
    } else if (dateProperty && !schema[dateProperty]) {
      console.warn(`  NOTION_DATE_PROPERTY "${dateProperty}" is not a property on that database. Skipping it.`);
    }
  } else {
    parent = { page_id: parentPageId };
    properties = { title: { title: richText(title) } };
  }

  // Create with the first batch, then append the rest 100 at a time.
  const first = blocks.slice(0, CHILDREN_PER_REQUEST);
  const rest = blocks.slice(CHILDREN_PER_REQUEST);

  const page = await notionRequest("/pages", {
    method: "POST",
    body: { parent, properties, children: first },
  });

  for (let i = 0; i < rest.length; i += CHILDREN_PER_REQUEST) {
    const batch = rest.slice(i, i + CHILDREN_PER_REQUEST);
    await notionRequest(`/blocks/${page.id}/children`, {
      method: "PATCH",
      body: { children: batch },
    });
    console.log(`  Appended ${batch.length} more blocks.`);
  }

  return { id: page.id, url: page.url };
}

export { CHILDREN_PER_REQUEST, RICH_TEXT_LIMIT };
