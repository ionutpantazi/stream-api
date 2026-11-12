import { createRadioServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}

const server = createRadioServer();
server.on('error', (error) => {
  console.error('Stream API server failed:', error);
  process.exitCode = 1;
});
server.listen(port, () => {
  console.log(`Stream API listening at http://localhost:${server.address().port}`);
});
