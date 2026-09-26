const http = require('node:http');
const server = http.createServer((req, res) => res.end(String(Math.random())));
server.listen(0, '127.0.0.1', () => {
  console.log(`ready ${server.address().port}`);
});
process.on('SIGTERM', () => {
  const started = Date.now();
  server.close(() => {
    console.log(`graceful shutdown took ${Date.now() - started >= 0 ? 'ok' : '??'}`);
    process.exit(0);
  });
});
