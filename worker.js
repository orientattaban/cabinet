/* Cabinet — optional outfit advisor backend (free tier)
 * ===========================================================================
 * YOU PROBABLY DON'T NEED THIS.
 *
 * The app already suggests outfits on its own, on the phone, for nothing:
 * it reads the colours out of your photo with a canvas and matches them
 * against the cabinet using colour theory and how dressed-up the occasion is.
 * No key, no account, no bill, and nothing leaves the device.
 *
 * This file is only for the day you'd rather hand the judgement to a proper
 * model — it will read a photo more cleverly than colour-averaging can, and
 * understand things like "something for a beach wedding". It uses Google's
 * Gemini free tier, which needs no credit card.
 *
 * SETTING IT UP — about ten minutes, no payment details anywhere
 *
 *  1. Go to aistudio.google.com, sign in with your Gmail, and click
 *     "Get API key" → "Create API key". The free tier is enough for this:
 *     roughly 15 requests a minute, which is far more than you'll ever use
 *     picking shoes. Check the current limits on that page before relying on
 *     it — Google changes them from time to time.
 *  2. Sign in at dash.cloudflare.com → Workers & Pages → Create → Worker.
 *     Name it "cabinet-advisor", Deploy, then Edit code.
 *  3. Replace everything in the editor with this file. Deploy.
 *  4. Settings → Variables and Secrets → Add → type Secret,
 *     name GEMINI_API_KEY, value your key. Deploy again.
 *  5. Copy the worker's address (it ends .workers.dev) into the app:
 *     Settings → Assistant.
 *
 *  If the worker is ever unreachable or out of quota, the app quietly falls
 *  back to its own matching — it never just fails.
 *
 *  Worth doing: set ALLOWED_ORIGIN to your own site so only your Cabinet can
 *  call this.
 */

const ALLOWED_ORIGIN = '*';        // e.g. 'https://orientattaban.github.io'
const MODEL = 'gemini-flash-latest';
const MAX_ITEMS = 120;

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Expected JSON' }, 400); }

    const outfit = String(body.outfit || '').slice(0, 2000);
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    const image = typeof body.image === 'string' ? body.image : null;

    if (!outfit && !image) return json({ error: 'Describe the outfit or send a photo' }, 400);
    if (!items.length) return json({ picks: [], note: 'The cabinet is empty.' });

    const parts = [];
    if (image) {
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
      if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
    parts.push({
      text:
`Someone is wearing this${outfit ? `: ${outfit}` : ' (see the photo)'}.

Things they own:
${items.map(i => `- id:${i.id} | ${i.drawer} | ${[i.brand, i.model].filter(Boolean).join(' ')} | colour: ${i.colour || 'unknown'} | used for: ${i.purpose || 'unspecified'}`).join('\n')}

Pick the two to four that would go best, best first, judging on colour,
formality and the occasion. Only choose from the list. If nothing really
suits, return an empty list and say why in the note instead of reaching.

Reply with JSON and nothing else:
{"picks":[{"id":"<id>","why":"<one short plain sentence>"}],"note":"<one line, or empty>"}`
    });

    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 700, responseMimeType: 'application/json' }
          })
        }
      );
    } catch {
      return json({ error: 'Could not reach the model' }, 502);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: 'Model error ' + res.status, detail: detail.slice(0, 300) }, 502);
    }

    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content?.parts || [])
      .map(p => p.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ picks: [], note: 'No suggestion this time.' });

    try {
      const parsed = JSON.parse(match[0]);
      const valid = new Set(items.map(i => String(i.id)));
      const picks = (parsed.picks || [])
        .filter(p => valid.has(String(p.id)))     // never invent something they don't own
        .slice(0, 4)
        .map(p => ({ id: String(p.id), why: String(p.why || '').slice(0, 300) }));
      return json({ picks, note: String(parsed.note || '').slice(0, 300) });
    } catch {
      return json({ picks: [], note: 'No suggestion this time.' });
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}
