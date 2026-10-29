// The board in a browser, for development only (`npm run dev`): the desktop app's own server
// answers nothing but its window.
import { startBoardServer } from './boardServer.js';
import { DATA_DIR } from './app.js';

const board = await startBoardServer({ dataDir: DATA_DIR, port: 4317, liveReload: process.argv.includes('--dev') });
console.log(`Agent Hub on ${board.url}`);

const shutdown = () => {
  board.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
