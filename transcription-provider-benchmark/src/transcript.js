/**
 * Flattens a MeetStream transcript into plain text in spoken order.
 *
 * get_transcript returns speaker-labelled segments. Two shapes are seen in
 * the wild (post-call-transcription/src/transcript.js handles the same two):
 *
 *   Documented:  [ { speaker, start_time, transcript, words: [ { word, punctuated_word, start } ] } ]
 *   Observed:    { message: [ { participant: { name }, words: [ { text, start_timestamp: { relative } } ] } ] }
 *
 * Speaker labels are dropped: this benchmark scores which words were heard,
 * not who said them.
 *
 * Anything else throws UnrecognizedTranscript rather than returning "": an
 * empty string would be scored as a provider that heard nothing (100% WER),
 * when the real cause is a response this code doesn't understand (an API
 * change, or an error page returned with status 200). An empty list is a
 * real "no speech" and gives "".
 */
class UnrecognizedTranscript extends Error {}

function transcriptText(data) {
  const segments = collectSegments(data);
  // Providers can return speakers' segments grouped rather than interleaved.
  // Reorder by start time, but only when every segment has one; otherwise
  // keep the order the API gave.
  if (segments.every((s) => typeof s.start === "number")) {
    segments.sort((a, b) => a.start - b.start);
  }
  return segments.map((s) => s.text).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

const describe = (data) => {
  const s = typeof data === "string" ? data : JSON.stringify(data) ?? String(data);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

function collectSegments(data) {
  if (typeof data === "string") {
    // Plain text is a transcript; markup or JSON is an error body.
    if (/^\s*[<{[]/.test(data) || /<\/?(html|body|head|h1|title)\b/i.test(data)) {
      throw new UnrecognizedTranscript(`transcript is not text: ${describe(data)}`);
    }
    return [{ start: 0, text: data }];
  }

  if (Array.isArray(data?.message)) {
    return data.message.map((entry) => {
      const words = entry?.words ?? [];
      return {
        start: words[0]?.start_timestamp?.relative ?? null,
        text: words.map((w) => w.text ?? w.word ?? "").join(" "),
      };
    });
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.transcript)
      ? data.transcript
      : Array.isArray(data?.data)
        ? data.data
        : null;
  if (!list) throw new UnrecognizedTranscript(`unrecognised transcript shape: ${describe(data)}`);

  // Every segment must carry text somewhere; segments that don't are a shape
  // this code doesn't know, not silence.
  if (list.length && !list.some((seg) => typeof (seg?.transcript ?? seg?.text) === "string" || Array.isArray(seg?.words))) {
    throw new UnrecognizedTranscript(`transcript segments have no text: ${describe(list[0])}`);
  }
  return list.map((seg) => {
    let text = seg?.transcript ?? seg?.text;
    if (typeof text !== "string" && Array.isArray(seg?.words)) {
      text = seg.words.map((w) => w.punctuated_word ?? w.word ?? w.text ?? "").join(" ");
    }
    return { start: seg?.start_time ?? seg?.start ?? seg?.words?.[0]?.start ?? null, text: text ?? "" };
  });
}

module.exports = { transcriptText, UnrecognizedTranscript };
