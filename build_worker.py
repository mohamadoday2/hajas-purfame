#!/usr/bin/env python3
"""يولّد public/_worker.js و public/_routes.json من server/worker.js
(تحتاجه فقط إذا عدّلت كود الطلبات. للموقع نفسه ما تحتاج أي بناء).
التشغيل:  python3 server/build_worker.py"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, '..', 'public')
src = open(os.path.join(HERE, 'worker.js'), encoding='utf-8').read()
src = src.replace('export function ', 'function ').replace('export default {', 'const api = {', 1)
assert 'export ' not in src
src += """
// ---- Cloudflare Pages entry: API routes run here, everything else is the static site ----
export default {
  async fetch(request, env, ctx) {
    const p = new URL(request.url).pathname;
    if (p.startsWith('/api/') || p === '/health' || p === '/admin') return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};
"""
open(os.path.join(PUB, '_worker.js'), 'w', encoding='utf-8').write(src)
json.dump({'version': 1, 'include': ['/api/*', '/admin', '/health'], 'exclude': []}, open(os.path.join(PUB, '_routes.json'), 'w'))
print('OK: public/_worker.js + public/_routes.json')
