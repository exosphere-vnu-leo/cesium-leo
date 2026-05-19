import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const config = {
  rootDir,
  port: Number(process.env.PORT ?? 3001),
  data: {
    groundStationsPath:
      process.env.GROUND_STATIONS_PATH ?? path.join(rootDir, 'ground_stations_vnu.basic.txt'),
    handoverPath:
      process.env.HANDOVER_CSV_PATH ?? path.join(rootDir, 'run001_handover_schedule_enriched.csv'),
    routingPath:
      process.env.ROUTING_CSV_PATH ?? path.join(rootDir, 'run001_routing_db_enriched.csv'),
    tlePath: process.env.TLE_PATH ?? path.join(rootDir, 'data/tle.txt'),
    startDatePath: process.env.START_DATE_PATH ?? path.join(rootDir, 'data/start_date.txt')
  }
};
