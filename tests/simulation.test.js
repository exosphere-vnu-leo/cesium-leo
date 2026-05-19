import request from 'supertest';
import { describe, expect, test, beforeAll } from 'vitest';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { SimulationEngine } from '../server/simulationEngine.js';
import { canonicalNodeName, qualityFromSinr, seededRandom } from '../server/utils.js';

let engine;
let app;

beforeAll(() => {
  engine = new SimulationEngine(config.data);
  app = createApp(engine);
});

describe('data normalization and simulation engine', () => {
  test('loads the expected manifest and normalizes node aliases', () => {
    const manifest = engine.manifest();
    expect(manifest.counts.nodes).toBe(7);
    expect(manifest.counts.satellites).toBe(40);
    expect(manifest.timeRange).toEqual({ min: 0, max: 5599 });
    expect(canonicalNodeName('HN')).toBe('HaNoi');
    expect(canonicalNodeName('DN')).toBe('DaNang');
    expect(canonicalNodeName('HCM')).toBe('HoChiMinh');
  });

  test('maps SINR bands to quality and deterministic success draws', () => {
    expect(qualityFromSinr(16).level).toBe('good');
    expect(qualityFromSinr(12).level).toBe('fair');
    expect(qualityFromSinr(4).level).toBe('poor');
    expect(qualityFromSinr(-1).level).toBe('critical');
    expect(seededRandom('503:41:40')).toBe(seededRandom('503:41:40'));
  });

  test('builds cumulative traffic for the first tick', () => {
    const frame = engine.frame(0);
    expect(frame.totals.sentBytes).toBe(300);
    expect(frame.totals.attemptedRoutes).toBe(30);
    expect(frame.nodes.every((node) => node.alive)).toBe(true);
  });

  test('keeps routing multi-link semantics at t=503 for DN', () => {
    const frame = engine.frame(503);
    const dnLinks = frame.links.filter((link) => link.sourceNodeId === 41);
    expect(dnLinks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dnLinks.map((link) => link.satelliteId)).size).toBeGreaterThanOrEqual(2);
  });

  test('exposes active satellite plane peers separately from route counts', () => {
    const frame = engine.frame(210);
    const trackedNames = frame.trackedSatellites.map((sat) => sat.name);
    expect(trackedNames).toContain('VNUSAT-021');
    expect(trackedNames).toContain('VNUSAT-022');
    expect(trackedNames).toContain('VNUSAT-030');
    expect(frame.trackedSatellites.find((sat) => sat.name === 'VNUSAT-021').routeCount).toBe(30);
  });

  test('deduplicates handover history and excludes stay by default', () => {
    const events = engine.getHandovers({ from: 503, to: 503, nodeId: 41 });
    expect(events.some((event) => event.event === 'handover')).toBe(true);
    expect(events.every((event) => event.event !== 'stay')).toBe(true);
    expect(new Set(events.map((event) => `${event.t}-${event.nodeId}-${event.oldSatId}-${event.newSatId}-${event.event}`)).size).toBe(events.length);
  });

  test('propagates TLE positions close to enriched satellite coordinates', () => {
    const sat13 = engine.frame(0).satellites[13];
    expect(Math.abs(sat13.lat - 26.4365)).toBeLessThan(1);
    expect(Math.abs(sat13.lon - 109.8332)).toBeLessThan(1);
  });

  test('returns focused node metrics, visible satellites, and loss series', () => {
    const detail = engine.nodeFrame(40, 0);
    expect(detail.node.name).toBe('HN');
    expect(detail.primaryRoute.satelliteId).toBe(13);
    expect(detail.visibleSatellites.length).toBeGreaterThan(0);
    expect(detail.lossSeries.length).toBe(1);
    expect(detail.node.quality.level).toBe('good');
  });
});

describe('api', () => {
  test('serves manifest and frames', async () => {
    const manifest = await request(app).get('/api/manifest').expect(200);
    expect(manifest.body.counts.nodes).toBe(7);

    const frame = await request(app).get('/api/frame?t=5599').expect(200);
    expect(frame.body.t).toBe(5599);
    expect(frame.body.satellites).toHaveLength(40);
  });

  test('serves node frame and handover API', async () => {
    const node = await request(app).get('/api/nodes/41/frame?t=503').expect(200);
    expect(node.body.activeRoutes.length).toBeGreaterThan(0);

    const handovers = await request(app).get('/api/handovers?from=503&to=503&nodeId=41').expect(200);
    expect(handovers.body.events.some((event) => event.event === 'handover')).toBe(true);
  });
});
