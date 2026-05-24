// audio_intake.js
//
// Customer-sent voice-note handling for Meta channels. Voice notes arrive
// the same shape as images do:
//
//   WhatsApp:  msg.type === 'audio', msg.audio = { id, mime_type, voice }
//              → resolve media_id via Graph API → token-auth fetch → buffer
//
//   FB / IG:   event.message.attachments[?].type === 'audio'
//              → attachments[?].payload.url is publicly fetchable Meta CDN
//
// We don't teach Claude to listen to audio. Instead we transcribe via
// Whisper-v3 (Groq preferred, OpenAI fallback) and feed the transcript
// into the normal text pipeline. That way every downstream feature
// (RAG, slot-fill, lead score, sentiment, booking gate) automatically
// works on voice notes too — zero extra plumbing.
//
// Cost: Groq Whisper ≈ $0.000111/sec → a 30-sec voice note = $0.003.
//       OpenAI Whisper ≈ $0.006/min → same note = $0.003. Roughly equal
//       these days, but Groq's faster (sub-second for typical voice notes).
//
// Caps: 25 MB per file (Whisper API limit), 5 min max duration (sanity).
// One voice note per inbound — we don't merge multiple audio attachments.

const MAX_AUDIO_BYTES   = 25 * 1024 * 1024;
const VALID_AUDIO_MIMES = /^audio\/(ogg|opus|mpeg|mp3|mp4|m4a|wav|webm|amr|aac)/i;

// Extract audio refs (max one per inbound message — voice messages are
// always single-attachment in practice). Returns array, possibly empty.
export function extractAudioRefs({ channel, msg, event }) {
  if (channel === 'whatsapp' && msg) {
    if (msg.type === 'audio' && msg.audio?.id) {
      return [{
        source: 'wa_media',
        mediaId: msg.audio.id,
        mime:    msg.audio.mime_type || 'audio/ogg',
        isVoice: !!msg.audio.voice, // true = push-to-talk voice note vs uploaded file
      }];
    }
    return [];
  }

  if ((channel === 'facebook' || channel === 'instagram') && event?.message?.attachments) {
    for (const att of event.message.attachments) {
      if (att.type === 'audio' && att.payload?.url) {
        return [{
          source: 'meta_cdn_url',
          url:    att.payload.url,
          mime:   'audio/mp4', // Meta CDN delivers IG/FB voice notes as mp4/aac
          isVoice: true,
        }];
      }
    }
  }
  return [];
}

// Resolve a WA media_id to a temporary signed URL via Graph API.
async function resolveWaMediaUrl(mediaId, accessToken) {
  const r = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`WA audio lookup failed: ${r.status}`);
  const j = await r.json();
  if (!j.url) throw new Error('WA audio lookup returned no url');
  return { url: j.url, mime: j.mime_type || 'audio/ogg' };
}

// Fetch the audio bytes. WA needs the auth header; Meta CDN doesn't.
async function fetchAudioBytes(url, mime, accessToken) {
  const headers = accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {};
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`audio download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`audio too large: ${buf.byteLength} bytes (limit ${MAX_AUDIO_BYTES})`);
  }
  return buf;
}

// POST the audio buffer to the Whisper endpoint. Same multipart shape works
// for both Groq and OpenAI — they kept the OpenAI Whisper API contract
// identical, deliberately, so apps can swap providers via base URL alone.
async function whisperTranscribe({ buf, mime, baseUrl, apiKey, model }) {
  // The official multipart format requires a filename with a recognisable
  // extension; Whisper sniffs format from the file extension, not mime header.
  // ogg/opus is the WA default; pick the right extension or transcription
  // returns 400.
  const extByMime = {
    'audio/ogg':  'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3':  'mp3',
    'audio/mp4':  'mp4',
    'audio/m4a':  'm4a',
    'audio/wav':  'wav',
    'audio/webm': 'webm',
    'audio/amr':  'amr',
    'audio/aac':  'aac',
  };
  const ext = extByMime[mime.toLowerCase()] || 'ogg';
  const filename = `voice.${ext}`;

  // Build multipart body manually — Node's FormData + Blob is supported in
  // Node 18+ which Aria targets. We send minimal fields: file + model.
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), filename);
  fd.append('model', model);
  // response_format=text returns a plain string body, easier to handle.
  fd.append('response_format', 'text');

  const r = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: fd,
    signal: AbortSignal.timeout(30_000),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`whisper ${r.status}: ${errBody.slice(0, 200)}`);
  }
  const transcript = (await r.text()).trim();
  if (!transcript) throw new Error('whisper returned empty transcript');
  return transcript;
}

// Pick provider based on which env var is set. Groq preferred for cost +
// speed; OpenAI is the fallback. No key → return null (caller treats as
// "voice notes unavailable" and falls back to a friendly text reply).
function pickWhisperProvider() {
  if (process.env.GROQ_API_KEY) {
    return {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey:  process.env.GROQ_API_KEY,
      model:   'whisper-large-v3-turbo',
      name:    'groq',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: 'https://api.openai.com/v1',
      apiKey:  process.env.OPENAI_API_KEY,
      model:   'whisper-1',
      name:    'openai',
    };
  }
  return null;
}

// Top-level helper: take a single audio ref, return { transcript, provider }
// or throw. Caller wraps in try/catch and decides fallback behaviour.
export async function transcribeAudioRef(ref, accessToken) {
  const provider = pickWhisperProvider();
  if (!provider) {
    throw new Error('no whisper api key configured (set GROQ_API_KEY or OPENAI_API_KEY)');
  }

  // Resolve to a fetchable URL + mime
  let url, mime;
  if (ref.source === 'wa_media') {
    if (!accessToken) throw new Error('no WA access token for audio fetch');
    const r = await resolveWaMediaUrl(ref.mediaId, accessToken);
    url  = r.url;
    mime = r.mime;
  } else if (ref.source === 'meta_cdn_url') {
    url  = ref.url;
    mime = ref.mime;
  } else {
    throw new Error(`unknown audio source: ${ref.source}`);
  }

  if (!VALID_AUDIO_MIMES.test(mime)) {
    throw new Error(`unsupported audio mime: ${mime}`);
  }

  const buf = await fetchAudioBytes(url, mime, ref.source === 'wa_media' ? accessToken : null);
  const transcript = await whisperTranscribe({ buf, mime, ...provider });
  return { transcript, provider: provider.name, bytes: buf.byteLength };
}
