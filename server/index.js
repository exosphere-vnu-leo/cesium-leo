import { createApp } from './app.js';
import { config } from './config.js';

console.log('Loading LEO handover simulation data...');
const app = createApp();
const manifest = app.locals.engine.manifest();
console.log(
  `Loaded ${manifest.counts.nodes} nodes, ${manifest.counts.satellites} satellites, ` +
    `${manifest.counts.routingRows} routing rows, ${manifest.counts.normalizedHandoverRows} handover states.`
);

app.listen(config.port, () => {
  console.log(`API server listening on http://localhost:${config.port}`);
});
