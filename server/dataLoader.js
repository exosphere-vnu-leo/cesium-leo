import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { Gateway, Router, Satellite } from './domain.js';
import {
  canonicalNodeName,
  nodeTypeFromName,
  toNumber,
  uniqBy
} from './utils.js';

export function loadGroundStations(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const byCanonicalName = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [localId, name, lat, lon, minElevationDeg] = line.split(',');
    const canonicalName = canonicalNodeName(name);
    byCanonicalName.set(canonicalName, {
      localId: toNumber(localId),
      name,
      canonicalName,
      lat: toNumber(lat),
      lon: toNumber(lon),
      minElevationDeg: toNumber(minElevationDeg, 0)
    });
  }
  return byCanonicalName;
}

export function loadTles(filePath) {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceLines = /^\d+$/.test(lines[0]) ? lines.slice(1) : lines;
  const satellites = [];
  for (let index = 0; index < sourceLines.length; index += 3) {
    const [name, line1, line2] = sourceLines.slice(index, index + 3);
    if (!name || !line1 || !line2) continue;
    satellites.push(new Satellite({ id: satellites.length, name, line1, line2 }));
  }
  return satellites;
}

export function loadStartDate(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return new Date(`${isoLike}Z`);
}

export function loadRouting(filePath, satellites) {
  const records = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true
  });
  const byTime = new Map();
  const nodeSeeds = new Map();

  for (const record of records) {
    const row = normalizeRoutingRecord(record, satellites);
    if (!byTime.has(row.t)) byTime.set(row.t, []);
    byTime.get(row.t).push(row);
    collectNodeSeed(nodeSeeds, row.srcId, row.srcName, row.srcLat, row.srcLon);
    collectNodeSeed(nodeSeeds, row.dstId, row.dstName, null, null);
  }

  const times = [...byTime.keys()].sort((a, b) => a - b);
  return {
    byTime,
    records: records.length,
    timeRange: {
      min: times[0] ?? 0,
      max: times[times.length - 1] ?? 0
    },
    nodeSeeds
  };
}

export function loadHandovers(filePath, satellites) {
  const records = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true
  });
  const normalized = records.map((record) => normalizeHandoverRecord(record, satellites));
  const deduped = uniqBy(
    normalized,
    (row) => `${row.t}-${row.nodeId}-${row.oldSatId}-${row.newSatId}-${row.event}`
  ).sort((a, b) => a.t - b.t || a.nodeId - b.nodeId || eventWeight(a.event) - eventWeight(b.event));

  const byTime = new Map();
  for (const row of deduped) {
    if (!byTime.has(row.t)) byTime.set(row.t, []);
    byTime.get(row.t).push(row);
  }

  return {
    records: records.length,
    normalizedRecords: deduped.length,
    events: deduped,
    byTime
  };
}

export function buildNodes(groundStations, nodeSeeds) {
  const nodes = new Map();
  for (const [id, seed] of nodeSeeds.entries()) {
    const canonicalName = canonicalNodeName(seed.name);
    const ground = groundStations.get(canonicalName);
    const base = {
      id,
      name: seed.name,
      canonicalName,
      lat: seed.lat ?? ground?.lat,
      lon: seed.lon ?? ground?.lon,
      minElevationDeg: ground?.minElevationDeg ?? 0
    };
    const NodeClass = nodeTypeFromName(canonicalName) === 'router' ? Router : Gateway;
    nodes.set(id, new NodeClass(base));
  }
  return nodes;
}

function collectNodeSeed(nodeSeeds, id, name, lat, lon) {
  if (!nodeSeeds.has(id)) {
    nodeSeeds.set(id, {
      id,
      name,
      lat,
      lon
    });
    return;
  }
  const existing = nodeSeeds.get(id);
  existing.name ||= name;
  existing.lat ??= lat;
  existing.lon ??= lon;
}

function normalizeRoutingRecord(record, satellites) {
  const t = toNumber(record.t, 0);
  const nextHopSatId = toNumber(record.next_hop);
  return {
    t,
    srcId: toNumber(record.src),
    dstId: toNumber(record.dst),
    nextHopSatId,
    nextNextHop: toNumber(record.next_next_hop),
    srcName: record.src_name,
    dstName: record.dst_name,
    pair: record.pair,
    srcLat: toNumber(record.src_lat),
    srcLon: toNumber(record.src_lon),
    satLat: toNumber(record.sat_lat),
    satLon: toNumber(record.sat_lon),
    satName: satellites[nextHopSatId]?.name ?? `SAT-${nextHopSatId}`,
    elevationUlDeg: toNumber(record.elevation_ul_deg),
    distUlKm: toNumber(record.dist_ul_km),
    nnhLat: toNumber(record.nnh_lat),
    nnhLon: toNumber(record.nnh_lon),
    elevationDlDeg: toNumber(record.elevation_dl_deg),
    distDlKm: toNumber(record.dist_dl_km),
    linkType: record.link_type,
    freqUlGhz: toNumber(record.freq_ul_ghz),
    freqDlGhz: toNumber(record.freq_dl_ghz),
    fsplUlDb: toNumber(record.fspl_ul_db, 0),
    fsplDlDb: toNumber(record.fspl_dl_db, 0),
    atmUlDb: toNumber(record.atm_ul_db, 0),
    atmDlDb: toNumber(record.atm_dl_db, 0),
    eirpGsDbw: toNumber(record.eirp_gs_dbw),
    cnUlDb: toNumber(record.cn_ul_db),
    eirpSatDbw: toNumber(record.eirp_sat_dbw),
    cnDlDb: toNumber(record.cn_dl_db),
    sinrDlDb: toNumber(record.sinr_dl_db),
    cnTotalDb: toNumber(record.cn_total_db)
  };
}

function normalizeHandoverRecord(record, satellites) {
  const newSatId = toNumber(record.new_sat);
  const oldSatId = toNumber(record.old_sat);
  return {
    t: toNumber(record.t_s, 0),
    tMs: toNumber(record.t_ms, 0),
    nodeId: toNumber(record.src_gw),
    nodeName: record.src_name,
    oldSatId,
    oldSatName: oldSatId >= 0 ? satellites[oldSatId]?.name ?? `SAT-${oldSatId}` : null,
    newSatId,
    newSatName: newSatId >= 0 ? satellites[newSatId]?.name ?? `SAT-${newSatId}` : null,
    event: record.event,
    gwLat: toNumber(record.gw_lat),
    gwLon: toNumber(record.gw_lon),
    oldSatLat: toNumber(record.old_sat_lat),
    oldSatLon: toNumber(record.old_sat_lon),
    newSatLat: toNumber(record.new_sat_lat),
    newSatLon: toNumber(record.new_sat_lon),
    elevationDeg: toNumber(record.new_elevation_deg),
    distanceKm: toNumber(record.new_dist_km)
  };
}

function eventWeight(event) {
  if (event === 'initial') return 0;
  if (event === 'handover') return 1;
  return 2;
}
