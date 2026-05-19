import {
  buildNodes,
  loadGroundStations,
  loadHandovers,
  loadRouting,
  loadStartDate,
  loadTles
} from './dataLoader.js';
import {
  average,
  clamp,
  median,
  qualityFromSinr,
  roleLabel,
  round,
  seededRandom
} from './utils.js';
import { choosePrimaryRoute } from './domain.js';

const BYTES_PER_ROUTE_PER_SECOND = 10;

export class SimulationEngine {
  constructor(dataConfig) {
    this.dataConfig = dataConfig;
    this.groundStations = loadGroundStations(dataConfig.groundStationsPath);
    this.satellites = loadTles(dataConfig.tlePath);
    this.startDate = loadStartDate(dataConfig.startDatePath);

    const routing = loadRouting(dataConfig.routingPath, this.satellites);
    this.routingByTime = routing.byTime;
    this.routingRecordCount = routing.records;
    this.timeRange = routing.timeRange;
    this.sortedTimes = [...this.routingByTime.keys()].sort((a, b) => a - b);
    this.propagationOffsetSec = this.estimatePropagationOffset();
    this.propagationStartDate = new Date(this.startDate.getTime() + this.propagationOffsetSec * 1000);

    this.nodes = buildNodes(this.groundStations, routing.nodeSeeds);
    this.nodeIds = [...this.nodes.keys()].sort((a, b) => a - b);

    const handovers = loadHandovers(dataConfig.handoverPath, this.satellites);
    this.handoverEvents = handovers.events;
    this.handoverByTime = handovers.byTime;
    this.rawHandoverRecordCount = handovers.records;
    this.normalizedHandoverRecordCount = handovers.normalizedRecords;

    this.trafficByTime = this.precomputeTraffic();
  }

  manifest() {
    return {
      timeRange: this.timeRange,
      startDate: this.startDate.toISOString(),
      propagationStartDate: this.propagationStartDate.toISOString(),
      propagationOffsetSec: this.propagationOffsetSec,
      counts: {
        nodes: this.nodes.size,
        satellites: this.satellites.length,
        routingRows: this.routingRecordCount,
        normalizedHandoverRows: this.normalizedHandoverRecordCount,
        rawHandoverRows: this.rawHandoverRecordCount
      },
      nodes: this.nodeIds.map((id) => this.nodes.get(id).baseSnapshot()),
      satellites: this.satellites.map((sat) => ({
        id: sat.id,
        name: sat.name,
        noradId: sat.noradId,
        planeId: Math.floor(sat.id / 10) + 1,
        slotInPlane: (sat.id % 10) + 1
      })),
      dataProvenance: {
        groundStationsPath: this.dataConfig.groundStationsPath,
        handoverPath: this.dataConfig.handoverPath,
        routingPath: this.dataConfig.routingPath,
        tlePath: this.dataConfig.tlePath,
        startDatePath: this.dataConfig.startDatePath
      }
    };
  }

  frame(tInput) {
    const t = this.normalizeTime(tInput);
    const rows = this.routingByTime.get(t) ?? [];
    const routesByNode = this.groupRoutesByNode(rows);
    const traffic = this.trafficByTime.get(t);
    const disconnectedNodeIds = new Set(
      (this.handoverByTime.get(t) ?? [])
        .filter((event) => event.newSatId === -1)
        .map((event) => event.nodeId)
    );

    const satellites = this.satellites.map((sat) => sat.positionAt(this.propagationStartDate, t));
    const activeSatelliteIds = [...new Set(rows.map((row) => row.nextHopSatId))];
    const trackedSatellites = this.trackedSatellites(activeSatelliteIds, satellites, rows);
    const handoverFocus = this.handoverFocus(t, satellites);
    const trailSatelliteIds = [
      ...new Set([
        ...activeSatelliteIds,
        ...handoverFocus.upcoming.flatMap((event) => [event.oldSatId, event.newSatId]),
        ...handoverFocus.recent.flatMap((event) => [event.oldSatId, event.newSatId])
      ])
    ].filter((id) => id >= 0);
    const nodes = this.nodeIds.map((id) => {
      const node = this.nodes.get(id);
      const snapshot = node.summarizeRoutes(routesByNode.get(id) ?? [], traffic?.perNode[id]);
      return disconnectedNodeIds.has(id) ? { ...snapshot, alive: false } : snapshot;
    });

    return {
      t,
      tMs: t * 1000,
      simulationTime: new Date(this.propagationStartDate.getTime() + t * 1000).toISOString(),
      timeRange: this.timeRange,
      satellites,
      trackedSatellites,
      orbitTrails: this.orbitTrails(trailSatelliteIds, t),
      nodes,
      links: this.buildActiveLinks(rows, satellites),
      handoverFocus,
      totals: traffic?.totals ?? {
        sentBytes: 0,
        receivedBytes: 0,
        failedBytes: 0,
        attemptedRoutes: 0,
        successfulRoutes: 0
      },
      recentHandovers: this.getHandovers({ from: Math.max(this.timeRange.min, t - 30), to: t })
        .filter((event) => event.event !== 'stay')
        .slice(-40)
    };
  }

  nodeFrame(nodeIdInput, tInput) {
    const nodeId = Number(nodeIdInput);
    const node = this.nodes.get(nodeId);
    if (!node) {
      const error = new Error(`Unknown node id: ${nodeIdInput}`);
      error.statusCode = 404;
      throw error;
    }

    const t = this.normalizeTime(tInput);
    const rows = this.routingByTime.get(t) ?? [];
    const outgoingRoutes = rows.filter((row) => row.srcId === nodeId);
    const incomingRoutes = rows.filter((row) => row.dstId === nodeId);
    const primary = choosePrimaryRoute(outgoingRoutes);
    const traffic = this.trafficByTime.get(t)?.perNode[nodeId] ?? emptyTraffic();
    const visibleSatellites = this.visibleSatellitesForNode(node, t, outgoingRoutes);
    const activeSatelliteIds = [...new Set(outgoingRoutes.map((row) => row.nextHopSatId))];
    const rainIndicator = this.rainIndicatorForNode(nodeId, t);
    const lossSeries = this.lossSeriesForNode(nodeId, t);

    return {
      t,
      tMs: t * 1000,
      simulationTime: new Date(this.propagationStartDate.getTime() + t * 1000).toISOString(),
      node: node.summarizeRoutes(outgoingRoutes, traffic),
      primaryRoute: primary ? this.routeSnapshot(primary) : null,
      activeRoutes: outgoingRoutes.map((route) => this.routeSnapshot(route)),
      incomingRoutes: incomingRoutes.map((route) => this.routeSnapshot(route)),
      visibleSatellites,
      orbitTrails: this.orbitTrails(activeSatelliteIds, t, 780, 60),
      antenna: primary
        ? {
            satelliteId: primary.nextHopSatId,
            satelliteName: primary.satName,
            elevationDeg: round(primary.elevationUlDeg, 2),
            rangeKm: round(primary.distUlKm, 1),
            azimuthDeg:
              visibleSatellites.find((sat) => sat.id === primary.nextHopSatId)?.azimuthDeg ?? null
          }
        : null,
      rainIndicator,
      lossSeries,
      handovers: this.getHandovers({ from: Math.max(this.timeRange.min, t - 120), to: t, nodeId })
        .filter((event) => event.event !== 'stay')
        .slice(-20)
    };
  }

  getHandovers({ from = this.timeRange.min, to = this.timeRange.max, nodeId, includeStay = false }) {
    const start = this.normalizeTime(from);
    const end = this.normalizeTime(to);
    const nodeIdNumber = nodeId == null || nodeId === '' ? null : Number(nodeId);
    return this.handoverEvents.filter((event) => {
      if (event.t < start || event.t > end) return false;
      if (nodeIdNumber != null && event.nodeId !== nodeIdNumber) return false;
      if (!includeStay && event.event === 'stay') return false;
      return true;
    });
  }

  normalizeTime(tInput) {
    const raw = Number(tInput ?? this.timeRange.min);
    const integer = Number.isFinite(raw) ? Math.round(raw) : this.timeRange.min;
    return clamp(integer, this.timeRange.min, this.timeRange.max);
  }

  groupRoutesByNode(rows) {
    const byNode = new Map();
    for (const row of rows) {
      if (!byNode.has(row.srcId)) byNode.set(row.srcId, []);
      byNode.get(row.srcId).push(row);
    }
    return byNode;
  }

  buildActiveLinks(rows, satellitePositions) {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.srcId}-${row.nextHopSatId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          sourceNodeId: row.srcId,
          sourceNodeName: row.srcName,
          satelliteId: row.nextHopSatId,
          satelliteName: row.satName,
          routeCount: 0,
          dstNodeIds: new Set(),
          dstNodeNames: new Set(),
          sinrValues: [],
          elevationValues: [],
          distances: []
        });
      }
      const group = groups.get(key);
      group.routeCount += 1;
      group.dstNodeIds.add(row.dstId);
      group.dstNodeNames.add(row.dstName);
      group.sinrValues.push(row.sinrDlDb);
      group.elevationValues.push(row.elevationUlDeg);
      group.distances.push(row.distUlKm);
    }

    return [...groups.values()].map((group) => {
      const avgSinr = average(group.sinrValues);
      const sourceNode = this.nodes.get(group.sourceNodeId);
      const satellitePosition = satellitePositions[group.satelliteId];
      return {
        sourceNodeId: group.sourceNodeId,
        sourceNodeName: group.sourceNodeName,
        satelliteId: group.satelliteId,
        satelliteName: group.satelliteName,
        routeCount: group.routeCount,
        dstNodeIds: [...group.dstNodeIds],
        dstNodeNames: [...group.dstNodeNames],
        avgSinrDlDb: round(avgSinr, 2),
        avgElevationDeg: round(average(group.elevationValues), 2),
        avgDistanceKm: round(average(group.distances), 1),
        quality: qualityFromSinr(avgSinr),
        source: sourceNode?.baseSnapshot() ?? null,
        satellite: satellitePosition ?? null
      };
    });
  }

  trackedSatellites(activeSatelliteIds, satellitePositions, rows) {
    const activeSet = new Set(activeSatelliteIds);
    const activePlanes = new Set(activeSatelliteIds.map((satId) => Math.floor(satId / 10)));
    const routeCountBySatellite = new Map();
    for (const row of rows) {
      routeCountBySatellite.set(row.nextHopSatId, (routeCountBySatellite.get(row.nextHopSatId) ?? 0) + 1);
    }

    return satellitePositions
      .filter((sat) => activePlanes.has(Math.floor(sat.id / 10)))
      .map((sat) => ({
        ...sat,
        active: activeSet.has(sat.id),
        routeCount: routeCountBySatellite.get(sat.id) ?? 0,
        planeId: Math.floor(sat.id / 10) + 1,
        slotInPlane: (sat.id % 10) + 1
      }));
  }

  handoverFocus(t, satellitePositions) {
    const attachPositions = (event) => ({
      ...event,
      oldSatellitePosition: event.oldSatId >= 0 ? satellitePositions[event.oldSatId] ?? null : null,
      newSatellitePosition: event.newSatId >= 0 ? satellitePositions[event.newSatId] ?? null : null
    });
    const recent = this.getHandovers({
      from: Math.max(this.timeRange.min, t - 240),
      to: t
    })
      .filter((event) => event.event === 'handover')
      .map(attachPositions);
    const upcoming = this.handoverEvents
      .filter((event) => event.event === 'handover' && event.t > t && event.t <= t + 420)
      .map(attachPositions);
    return {
      recent: groupHandoverEvents(recent).slice(-8),
      upcoming: groupHandoverEvents(upcoming).slice(0, 10)
    };
  }

  routeSnapshot(route) {
    return {
      t: route.t,
      srcId: route.srcId,
      dstId: route.dstId,
      srcName: route.srcName,
      dstName: route.dstName,
      pair: route.pair,
      satelliteId: route.nextHopSatId,
      satelliteName: route.satName,
      linkType: route.linkType,
      role: roleLabel(route.linkType, route.freqUlGhz, route.freqDlGhz),
      freqUlGhz: route.freqUlGhz,
      freqDlGhz: route.freqDlGhz,
      elevationUlDeg: round(route.elevationUlDeg, 2),
      elevationDlDeg: round(route.elevationDlDeg, 2),
      distUlKm: round(route.distUlKm, 1),
      distDlKm: round(route.distDlKm, 1),
      uplinkLossDb: round(route.fsplUlDb + route.atmUlDb, 2),
      downlinkLossDb: round(route.fsplDlDb + route.atmDlDb, 2),
      fsplUlDb: round(route.fsplUlDb, 2),
      fsplDlDb: round(route.fsplDlDb, 2),
      atmUlDb: round(route.atmUlDb, 2),
      atmDlDb: round(route.atmDlDb, 2),
      cnUlDb: round(route.cnUlDb, 2),
      cnDlDb: round(route.cnDlDb, 2),
      sinrDlDb: round(route.sinrDlDb, 2),
      cnTotalDb: round(route.cnTotalDb, 2),
      quality: qualityFromSinr(route.sinrDlDb)
    };
  }

  visibleSatellitesForNode(node, t, activeRoutes) {
    const activeBySat = new Map();
    for (const route of activeRoutes) {
      if (!activeBySat.has(route.nextHopSatId)) activeBySat.set(route.nextHopSatId, []);
      activeBySat.get(route.nextHopSatId).push(route);
    }

    return this.satellites
      .map((sat) => {
        const look = sat.lookAnglesFrom(node, this.propagationStartDate, t);
        const activeRows = activeBySat.get(sat.id) ?? [];
        const avgSinr = average(activeRows.map((row) => row.sinrDlDb));
        return {
          id: sat.id,
          name: sat.name,
          position: sat.positionAt(this.propagationStartDate, t),
          active: activeRows.length > 0,
          routeCount: activeRows.length,
          azimuthDeg: look?.azimuthDeg ?? null,
          elevationDeg: look?.elevationDeg ?? null,
          rangeKm: look?.rangeKm ?? null,
          routingElevationDeg: round(average(activeRows.map((row) => row.elevationUlDeg)), 2),
          sinrDlDb: round(avgSinr, 2),
          quality: qualityFromSinr(avgSinr),
          visible: Boolean(look?.visible) || activeRows.length > 0
        };
      })
      .filter((sat) => sat.visible)
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return (right.elevationDeg ?? -Infinity) - (left.elevationDeg ?? -Infinity);
      });
  }

  rainIndicatorForNode(nodeId, t) {
    const rows = this.routingByTime.get(t)?.filter((row) => row.srcId === nodeId) ?? [];
    const currentUl = average(rows.map((row) => row.atmUlDb));
    const currentDl = average(rows.map((row) => row.atmDlDb));
    const ulHistory = [];
    const dlHistory = [];

    for (let second = Math.max(this.timeRange.min, t - 30); second < t; second += 1) {
      const secondRows = this.routingByTime.get(second)?.filter((row) => row.srcId === nodeId) ?? [];
      const ul = average(secondRows.map((row) => row.atmUlDb));
      const dl = average(secondRows.map((row) => row.atmDlDb));
      if (ul != null) ulHistory.push(ul);
      if (dl != null) dlHistory.push(dl);
    }

    const ulMedian = median(ulHistory);
    const dlMedian = median(dlHistory);
    const ulSpike = currentUl != null && ulMedian != null && currentUl - ulMedian >= 0.75;
    const dlSpike = currentDl != null && dlMedian != null && currentDl - dlMedian >= 0.75;
    return {
      atmUlDb: round(currentUl, 2),
      atmDlDb: round(currentDl, 2),
      medianUlDb: round(ulMedian, 2),
      medianDlDb: round(dlMedian, 2),
      ulSpike,
      dlSpike,
      active: ulSpike || dlSpike
    };
  }

  lossSeriesForNode(nodeId, t) {
    const start = Math.max(this.timeRange.min, t - 59);
    const series = [];
    for (let second = start; second <= t; second += 1) {
      const rows = this.routingByTime.get(second)?.filter((row) => row.srcId === nodeId) ?? [];
      series.push({
        t: second,
        uplinkLossDb: round(average(rows.map((row) => row.fsplUlDb + row.atmUlDb)), 2),
        downlinkLossDb: round(average(rows.map((row) => row.fsplDlDb + row.atmDlDb)), 2),
        sinrDlDb: round(average(rows.map((row) => row.sinrDlDb)), 2)
      });
    }
    return series;
  }

  orbitTrails(satelliteIds, t, spanSec = 960, stepSec = 60) {
    return satelliteIds
      .map((satId) => {
        const sat = this.satellites[satId];
        if (!sat) return null;
        const points = [];
        for (let dt = -spanSec; dt <= spanSec; dt += stepSec) {
          const sampleTime = clamp(t + dt, this.timeRange.min, this.timeRange.max);
          const position = sat.positionAt(this.propagationStartDate, sampleTime);
          if (position?.lat != null && position?.lon != null) {
            points.push({
              t: sampleTime,
              lat: position.lat,
              lon: position.lon,
              altKm: position.altKm
            });
          }
        }
        return {
          satelliteId: sat.id,
          satelliteName: sat.name,
          points
        };
      })
      .filter(Boolean);
  }

  estimatePropagationOffset() {
    const rows = this.routingByTime.get(this.timeRange.min) ?? [];
    const samples = rows
      .filter((row) => Number.isFinite(row.satLat) && Number.isFinite(row.satLon))
      .slice(0, 8);
    if (!samples.length) return 0;

    let best = { offset: 0, score: Number.POSITIVE_INFINITY };
    for (let offset = -600; offset <= 600; offset += 1) {
      const score =
        samples.reduce((sum, row) => {
          const sat = this.satellites[row.nextHopSatId];
          const position = sat?.positionAt(this.startDate, this.timeRange.min + offset);
          if (!position || position.lat == null || position.lon == null) return sum + 9999;
          const latDiff = position.lat - row.satLat;
          const lonDiff = longitudeDelta(position.lon, row.satLon);
          return sum + Math.hypot(latDiff, lonDiff);
        }, 0) / samples.length;
      if (score < best.score) best = { offset, score };
    }

    return best.score < 2 ? best.offset : 0;
  }

  precomputeTraffic() {
    const trafficByTime = new Map();
    const cumulative = new Map();
    let totalSent = 0;
    let totalReceived = 0;
    let totalFailed = 0;
    let attemptedRoutes = 0;
    let successfulRoutes = 0;

    for (const nodeId of this.nodeIds) {
      cumulative.set(nodeId, emptyTraffic());
    }

    for (const t of this.sortedTimes) {
      const rows = this.routingByTime.get(t) ?? [];
      for (const row of rows) {
        if (!cumulative.has(row.srcId)) cumulative.set(row.srcId, emptyTraffic());
        if (!cumulative.has(row.dstId)) cumulative.set(row.dstId, emptyTraffic());
        const srcTraffic = cumulative.get(row.srcId);
        const dstTraffic = cumulative.get(row.dstId);
        const probability = qualityFromSinr(row.sinrDlDb).probability;
        const success = seededRandom(`${row.t}:${row.srcId}:${row.dstId}`) <= probability;

        srcTraffic.sentBytes += BYTES_PER_ROUTE_PER_SECOND;
        srcTraffic.uplinkBytes += BYTES_PER_ROUTE_PER_SECOND;
        totalSent += BYTES_PER_ROUTE_PER_SECOND;
        attemptedRoutes += 1;

        if (success) {
          dstTraffic.receivedBytes += BYTES_PER_ROUTE_PER_SECOND;
          dstTraffic.downlinkBytes += BYTES_PER_ROUTE_PER_SECOND;
          totalReceived += BYTES_PER_ROUTE_PER_SECOND;
          successfulRoutes += 1;
        } else {
          srcTraffic.failedBytes += BYTES_PER_ROUTE_PER_SECOND;
          totalFailed += BYTES_PER_ROUTE_PER_SECOND;
        }
      }

      trafficByTime.set(t, {
        perNode: Object.fromEntries(
          [...cumulative.entries()].map(([nodeId, traffic]) => [nodeId, { ...traffic }])
        ),
        totals: {
          sentBytes: totalSent,
          receivedBytes: totalReceived,
          failedBytes: totalFailed,
          attemptedRoutes,
          successfulRoutes
        }
      });
    }
    return trafficByTime;
  }
}

function longitudeDelta(left, right) {
  let delta = left - right;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function groupHandoverEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.t}-${event.oldSatId}-${event.newSatId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ...event,
        nodeIds: [],
        nodeNames: []
      });
    }
    const group = groups.get(key);
    group.nodeIds.push(event.nodeId);
    group.nodeNames.push(event.nodeName);
    group.nodeName = group.nodeNames.length === 1 ? group.nodeNames[0] : `${group.nodeNames.length} nodes`;
  }
  return [...groups.values()];
}

export function emptyTraffic() {
  return {
    sentBytes: 0,
    receivedBytes: 0,
    uplinkBytes: 0,
    downlinkBytes: 0,
    failedBytes: 0
  };
}
