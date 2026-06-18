export default async function handler(req: Request): Promise<Response> {
  return new Response(JSON.stringify({ method: req.method, ok: true, ts: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
