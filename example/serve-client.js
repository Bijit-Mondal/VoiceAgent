const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// Create a simple HTTP server to serve the voice client HTML
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'voice-client.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading voice-client.html');
        return;
      }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Voice client available at: http://localhost:${PORT}`);
  console.log(`Make sure to also start the WebSocket server with: npm run ws:server`);
});