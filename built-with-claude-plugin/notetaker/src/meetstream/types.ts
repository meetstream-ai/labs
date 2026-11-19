/** One line of a post-call transcript. */
export interface TranscriptSegment {
  speaker: string;
  transcript: string;
  start?: number;
  end?: number;
}

export interface BotDetails {
  transcript_id?: string;
  TranscriptStatus?: string;
  MeetingLink?: string;
  custom_attributes?: Record<string, string>;
  [key: string]: unknown;
}

export interface CreateBotOptions {
  meetingLink: string;
  callbackUrl: string;
  botName: string;
  transcriptProvider: 'deepgram' | 'assemblyai' | 'meetstream';
  language: string;
  customAttributes?: Record<string, string>;
}
