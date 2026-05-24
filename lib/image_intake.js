// image_intake.js
//
// Customer-sent image handling for Meta channels. Two source shapes:
//
//   WhatsApp:  msg.image = { id, mime_type }
//              → resolve media_id via Graph API to a token-protected URL
//              → fetch with Authorization: Bearer → base64
//              → Claude image block source = { type:'base64', media_type, data }
//
//   FB/IG:     event.message.attachments = [{ type:'image', payload:{url} }]
//              → URL is publicly fetchable (Meta CDN)
//              → Claude image block source = { type:'url', url }
//
// Why two paths: WA media URLs are token-gated (expire ~5min, need WA token
// in the Authorization header). Anthropic's fetcher can't carry that header,
// so we fetch + inline as base64. FB/IG CDN URLs are signed but publicly
// readable, so Claude can fetch them directly = cheaper (no upload bandwidth).
//
// Cap per message: 4 images, 5MB each (Anthropic limit is 5MB base64).
// Anything beyond that we drop with a warning — keeps a malicious sender
// from flooding token budget.

const MAX_IMAGES_PER_MSG = 4;
const MAX_IMAGE_BYTES    = 5 * 1024 * 1024;
const VALID_MIME_RE      = /^image\/(jpeg|png|gif|webp)$/;

// Pull image refs out of a single inbound payload. Returns array of refs
// (possibly empty). Caller decides whether to skip the message or proceed
// with text + images / images-only.
export function extractImageRefs({ channel, msg, event }) {
  const refs = [];

  if (channel === 'whatsapp' && msg) {
    // WA supports image OR sticker (also image-shaped). Skip stickers — usually
    // meaningless emoji-art and burns tokens.
    if (msg.type === 'image' && msg.image?.id) {
      refs.push({
        source: 'wa_media',
        mediaId: msg.image.id,
        mime:    msg.image.mime_type || 'image/jpeg',
      });
    }
    return refs;
  }

  // FB Messenger + IG Direct share the same attachment shape under
  // event.message.attachments[]. type can be image / video / file / audio / fallback.
  if ((channel === 'facebook' || channel === 'instagram') && event?.message?.attachments) {
    for (const att of event.message.attachments) {
      if (att.type !== 'image') continue;
      if (!att.payload?.url) continue;
      refs.push({
        source: 'meta_cdn_url',
        url:    att.payload.url,
        mime:   'image/jpeg', // Meta CDN doesn't reliably expose mime; default works
      });
    }
  }

  return refs.slice(0, MAX_IMAGES_PER_MSG);
}

// Resolve one WA media_id to { url, mime_type } via Graph API.
// WA media URLs expire ~5min so we fetch immediately downstream.
async function resolveWaMediaUrl(mediaId, accessToken) {
  const r = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`WA media lookup failed: ${r.status}`);
  const j = await r.json();
  if (!j.url) throw new Error('WA media lookup returned no url');
  return { url: j.url, mime: j.mime_type || 'image/jpeg' };
}

// Fetch a WA media URL using the access token, return base64 + size guard.
async function fetchWaMediaAsBase64(url, mime, accessToken) {
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`WA media download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`WA media too large: ${buf.byteLength} bytes`);
  }
  return { base64: buf.toString('base64'), mime };
}

// Turn extracted refs into Anthropic content blocks. Returns {blocks, errors}.
// blocks is suitable for spreading into a messages[].content array right
// before the user's text block.
//
// FAILURE POLICY (decided product-side): if one image fails to load we drop
// just that image and continue — don't fail the whole reply. The customer
// shouldn't be told "your image broke" because (a) it usually didn't —
// it's a token/network blip and (b) Aria can often still answer from text.
// We DO surface errors to Kyle's admin log so chronic failures get noticed.
export async function resolveImageRefsToBlocks(refs, accessToken) {
  const blocks = [];
  const errors = [];

  for (const ref of refs) {
    try {
      if (ref.source === 'wa_media') {
        if (!accessToken) throw new Error('no access token for WA media');
        const { url, mime } = await resolveWaMediaUrl(ref.mediaId, accessToken);
        if (!VALID_MIME_RE.test(mime)) throw new Error(`unsupported mime: ${mime}`);
        const { base64, mime: m2 } = await fetchWaMediaAsBase64(url, mime, accessToken);
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: m2, data: base64 },
        });
      } else if (ref.source === 'meta_cdn_url') {
        // Meta CDN URLs are publicly fetchable + signed. Anthropic's url
        // fetcher will pull them directly = lower bandwidth for us.
        blocks.push({
          type: 'image',
          source: { type: 'url', url: ref.url },
        });
      }
    } catch (e) {
      errors.push({ ref, error: e.message });
    }
  }

  return { blocks, errors };
}
