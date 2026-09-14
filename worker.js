/* Cabinet — outfit advisor backend
 * ---------------------------------------------------------------------------
 * The app is a static page, so it cannot hold an API key: anyone who opened it
 * could read the key out of the source and spend your money. This tiny service
 * holds the key instead. The app sends it an outfit (text and/or a photo) plus
 * a list of what is in the cabinet, and gets back which things go together.
 *
 * SETTING IT UP — about ten minutes, free tier is plenty
 *
 *  1. Get an API key at console.anthropic.com (Settings → API keys).
 *  2. Sign in at dash.cloudflare.com → Workers & Pages → Create → Worker.
 *     Name it something like "cabinet-advisor", Deploy, then Edit code.
 *  3. Replace everything in the editor with this file. Deploy.
 *  4. Back on the Worker's page: Settings → Variables and Secrets →
 *     Add → type Secret, name ANTHROPIC_API_KEY, value your key. Deploy again.
 *  5. Settings → Domains & Routes shows the address, ending .workers.dev.
 *     Paste that into the app: Settings → Assistant.
 *
 *  Optional but worth it: set ALLOWED_ORIGIN below to your site so that only
 *  your own Cabinet can call this worker.
 */

const ALLOWED_ORIGIN = '*';           // e.g. 'https://orientattaban.github.io'
const MODEL = 'claude-sonnet-4-5';
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

    const content = [];
    if (image) {
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(image);
      if (m) content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] }
      });
    }
    content.push({
      type: 'text',
      text:
`Here is what someone is wearing${outfit ? `: ${outfit}` : ' (see the photo)'}.

These are the things they own:
${items.map(i => `- id:${i.id} | ${i.drawer} | ${[i.brand, i.model].filter(Boolean).join(' ')} | colour: ${i.colour || 'unknown'} | used for: ${i.purpose || 'unspecified'}`).join('\n')}

Pick the two to four that would go best with the outfit, best first. Judge on
colour, formality and the occasion. Only pick things from the list. If nothing
really suits, say so rather than reaching.

Reply with JSON only, in this exact shape:
{"picks":[{"id":"<the id>","why":"<one short sentence, plain language>"}],"note":"<optional one-line caveat, or empty>"}`
    });

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 700,
          messages: [{ role: 'user', content }]
        })
      });
    } catch (e) {
      return json({ error: 'Could not reach the model' }, 502);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ error: 'Model error ' + res.status, detail: detail.slice(0, 300) }, 502);
    }

    const data = await res.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const match = text.match(/\{[\s\S]*\}/);           // the model may wrap it in prose
    if (!match) return json({ picks: [], note: 'No suggestion this time.' });

    try {
      const parsed = JSON.parse(match[0]);
      const valid = new Set(items.map(i => String(i.id)));
      const picks = (parsed.picks || [])
        .filter(p => valid.has(String(p.id)))          // never invent an item
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
