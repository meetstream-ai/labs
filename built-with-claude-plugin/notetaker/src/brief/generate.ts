import type { LlmProvider } from '../llm/types.js';
import type { TranscriptSegment } from '../meetstream/types.js';

export const SYSTEM_PROMPT = `You are a meeting analyst. You are given a transcript of a meeting.

Write a markdown brief with exactly these sections, in this order:

## Summary
Three sentences at most, covering what the meeting was about and where it landed.

## Decisions
Bullets. Only decisions the participants actually settled. If none, write "None recorded."

## Action Items
Bullets of the form "- **Owner** — task (due date)". Omit the due date if nobody gave one.
Use "Unassigned" when no owner is named. If none, write "None recorded."

## Open Questions
Bullets of anything left unresolved. If none, write "None recorded."

Rules:
- Use speaker names exactly as they appear in the transcript.
- Never invent decisions, owners or dates. Absence is a valid answer.
- Output only the markdown brief, with no preamble.`;

export interface GenerateBriefOptions {
  segments: TranscriptSegment[];
  llm: LlmProvider;
  meetingLink?: string | undefined;
}

export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `${segment.speaker ?? 'Unknown'}: ${segment.transcript ?? ''}`.trim())
    .filter((line) => line.length > 0 && !line.endsWith(':'))
    .join('\n');
}

export async function generateBrief(options: GenerateBriefOptions): Promise<string> {
  const transcript = formatTranscript(options.segments);
  if (!transcript) {
    throw new Error('Transcript is empty — nothing to summarise');
  }

  const context = options.meetingLink ? `Meeting link: ${options.meetingLink}\n\n` : '';
  return options.llm.complete({
    system: SYSTEM_PROMPT,
    prompt: `${context}Transcript:\n\n${transcript}`,
  });
}
