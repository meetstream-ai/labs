// Shared state for one run: the bot this process created.
// Filled in by createBot, read by the webhook handler once
// transcription.processed arrives.
module.exports = {
  botId: null,
  transcriptId: null,
  fetching: false,
  transcriptFailed: false,
};
