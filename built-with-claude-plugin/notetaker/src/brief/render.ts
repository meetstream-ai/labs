import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface BriefDocument {
  botId: string;
  body: string;
  meetingLink?: string | undefined;
  generatedAt?: Date;
}

export function renderBrief(document: BriefDocument): string {
  const generatedAt = document.generatedAt ?? new Date();
  const front = ['# Meeting Brief', '', `- Bot: \`${document.botId}\``];
  if (document.meetingLink) front.push(`- Meeting: ${document.meetingLink}`);
  front.push(`- Generated: ${generatedAt.toISOString()}`, '', '---', '', '');
  return `${front.join('\n')}${document.body.trim()}\n`;
}

/** Filenames are derived from the bot id, so a re-run overwrites rather than piles up. */
export function briefFilename(botId: string, generatedAt: Date = new Date()): string {
  const date = generatedAt.toISOString().slice(0, 10);
  const safeBotId = botId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${date}-${safeBotId}.md`;
}

export async function writeBrief(
  directory: string,
  document: BriefDocument,
): Promise<{ path: string; contents: string }> {
  const generatedAt = document.generatedAt ?? new Date();
  const path = resolve(join(directory, briefFilename(document.botId, generatedAt)));
  const contents = renderBrief({ ...document, generatedAt });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
  return { path, contents };
}
