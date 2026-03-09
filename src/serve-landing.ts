const port = parseInt(process.env.PORT ?? '3000');
const htmlPath = process.cwd() + '/pdpa-readiness-check.html';

console.log(`Serving HTML from: ${htmlPath}`);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    return new Response(Bun.file(htmlPath), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
});

console.log(`Landing page running on port ${port}`);
