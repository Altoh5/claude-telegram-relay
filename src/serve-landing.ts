const port = parseInt(process.env.PORT ?? '3000');
const html = Bun.file(new URL('../../pdpa-readiness-check.html', import.meta.url));

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    return new Response(await html.text(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
});

console.log(`Landing page running on port ${port}`);
