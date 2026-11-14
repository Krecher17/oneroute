export function registerTrafficRoutes(app) {
  const key = process.env.TOMTOM_TRAFFIC_API_KEY?.trim();
  app.get('/api/traffic/status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ available: Boolean(key) });
  });
  app.get('/api/traffic/tiles/:z/:x/:y', async (req, res) => {
    if (!key) return res.sendStatus(503);
    const values = [req.params.z, req.params.x, req.params.y];
    if (!values.every(value => /^\d{1,7}$/.test(value))) return res.sendStatus(400);
    const [z, x, y] = values.map(Number);
    if (z < 7 || z > 22 || x >= 2 ** z || y >= 2 ** z) return res.sendStatus(400);

    try {
      const url = 'https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/' + z + '/' + x + '/' + y;
      const upstream = await fetch(url, {
        headers: { 'TomTom-Api-Key': key },
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('image/png')) {
        await upstream.body?.cancel();
        return res.sendStatus(upstream.status === 429 ? 503 : 502);
      }
      const tile = Buffer.from(await upstream.arrayBuffer());
      return res.set('Cache-Control', 'private, max-age=45').type('png').send(tile);
    } catch {
      return res.sendStatus(502);
    }
  });
}
