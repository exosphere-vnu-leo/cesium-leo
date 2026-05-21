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
  haversineDistanceKm,
  median,
  qualityFromSinr,
  roleLabel,
  round,
  seededRandom
} from './utils.js';
import { choosePrimaryRoute, normalizePlanType } from './domain.js';
import { DeviceVerificationRegistry } from './deviceVerification.js';

const BYTES_PER_ROUTE_PER_SECOND = 10;
const FIXED_RADIUS_KM = 0.5;
const MOBILITY_DISCONNECT_KM = 1000;

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
    this.verification = new DeviceVerificationRegistry(this.nodes);
    this.violations = [];

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
    const rawRows = this.routingByTime.get(t) ?? [];
    const rows = this.adjustedRowsForTime(t);
    const routesByNode = this.groupRoutesByNode(rows);
    const rawRoutesByNode = this.groupRoutesByNode(rawRows);
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
      const routes = routesByNode.get(id) ?? [];
      const rawRoutes = rawRoutesByNode.get(id) ?? [];
      const snapshot = node.summarizeRoutes(routes, traffic?.perNode[id]);
      return this.withRuntimeNodeStatus(snapshot, node, t, routes, rawRoutes, {
        csvDisconnected: disconnectedNodeIds.has(id)
      });
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
      suspendedRouters: nodes.filter((node) => node.status === 'SUSPENDED'),
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
    const rawRows = this.routingByTime.get(t) ?? [];
    const rows = this.adjustedRowsForTime(t);
    const outgoingRoutes = rows.filter((row) => row.srcId === nodeId);
    const incomingRoutes = rows.filter((row) => row.dstId === nodeId);
    const rawOutgoingRoutes = rawRows.filter((row) => row.srcId === nodeId);
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
      node: this.withRuntimeNodeStatus(
        node.summarizeRoutes(outgoingRoutes, traffic),
        node,
        t,
        outgoingRoutes,
        rawOutgoingRoutes
      ),
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

  adjustedRowsForTime(t) {
    return (this.routingByTime.get(t) ?? [])
      .map((row) => this.adjustRouteForRuntime(row, t))
      .filter(Boolean);
  }

  adjustRouteForRuntime(row, t) {
    if (this.routeBlockedBySuspension(row, t)) return null;

    let adjusted = row;
    for (const endpoint of [
      {
        nodeId: row.srcId,
        distField: 'distUlKm',
        originalLat: row.srcLat,
        originalLon: row.srcLon,
        updateSourcePosition: true
      },
      {
        nodeId: row.dstId,
        distField: 'distDlKm',
        originalLat: row.nnhLat,
        originalLon: row.nnhLon,
        updateSourcePosition: false
      }
    ]) {
      const node = this.nodes.get(endpoint.nodeId);
      if (!this.mobilityOverrideActive(node, t)) continue;

      const satPoint = this.routeSatellitePoint(row, t);
      if (satPoint?.lat == null || satPoint?.lon == null) continue;
      const newDistanceKm = haversineDistanceKm(node.lat, node.lon, satPoint.lat, satPoint.lon);
      if (newDistanceKm == null || newDistanceKm > MOBILITY_DISCONNECT_KM) return null;

      const originalDistanceKm =
        haversineDistanceKm(endpoint.originalLat, endpoint.originalLon, satPoint.lat, satPoint.lon) ??
        row[endpoint.distField];
      const ratio = Number(originalDistanceKm) > 0 ? Number(originalDistanceKm) / Math.max(1, newDistanceKm) : 1;
      const sinrDeltaDb = 20 * Math.log10(ratio);

      adjusted = adjusted === row ? { ...row } : adjusted;
      adjusted[endpoint.distField] = newDistanceKm;
      adjusted.sinrDlDb += sinrDeltaDb;
      adjusted.cnTotalDb += sinrDeltaDb;
      if (endpoint.updateSourcePosition) {
        adjusted.srcLat = node.lat;
        adjusted.srcLon = node.lon;
      }
    }

    return adjusted;
  }

  routeBlockedBySuspension(row, t) {
    return [row.srcId, row.dstId].some((nodeId) => {
      const node = this.nodes.get(nodeId);
      return (
        node?.type === 'router' &&
        node.suspended &&
        this.locationOverrideActive(node, t) &&
        node.suspendedSinceT != null &&
        t >= node.suspendedSinceT
      );
    });
  }

  routeSatellitePoint(row, t) {
    if (Number.isFinite(row.satLat) && Number.isFinite(row.satLon)) {
      return { lat: row.satLat, lon: row.satLon };
    }
    return this.satellites[row.nextHopSatId]?.positionAt(this.propagationStartDate, t) ?? null;
  }

  locationOverrideActive(node, t) {
    return (
      node?.locationOverridden &&
      (node.positionUpdatedAtT == null || t >= node.positionUpdatedAtT)
    );
  }

  mobilityOverrideActive(node, t) {
    return node?.type === 'router' && node.planType === 'MOBILITY' && this.locationOverrideActive(node, t);
  }

  withRuntimeNodeStatus(snapshot, node, t, routes, rawRoutes, options = {}) {
    const status = this.runtimeNodeStatus(node, t, routes, rawRoutes, options);
    const forcedDown = status === 'SUSPENDED' || status === 'DISCONNECTED' || options.csvDisconnected;
    const relocationDistanceKm = this.locationOverrideActive(node, t) ? node.relocationDistanceKm : 0;
    return {
      ...snapshot,
      alive: forcedDown ? false : snapshot.alive,
      status,
      suspended: status === 'SUSPENDED',
      relocationDistanceKm: round(relocationDistanceKm, 3)
    };
  }

  runtimeNodeStatus(node, t, routes, rawRoutes, options = {}) {
    if (options.csvDisconnected) return 'DISCONNECTED';
    if (node.type !== 'router') return 'ACTIVE';
    const overrideActive = this.locationOverrideActive(node, t);
    if (node.suspended && overrideActive && node.suspendedSinceT != null && t >= node.suspendedSinceT) {
      return 'SUSPENDED';
    }
    if (node.planType === 'MOBILITY' && overrideActive && rawRoutes.length > 0 && routes.length === 0) {
      return 'DISCONNECTED';
    }
    if (node.planType === 'MOBILITY') return 'ALLOWED';
    return overrideActive && node.relocationDistanceKm > node.homeRadiusKm ? 'SUSPENDED' : 'INSIDE';
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
    const rows = this.adjustedRowsForTime(t).filter((row) => row.srcId === nodeId);
    const currentUl = average(rows.map((row) => row.atmUlDb));
    const currentDl = average(rows.map((row) => row.atmDlDb));
    const ulHistory = [];
    const dlHistory = [];

    for (let second = Math.max(this.timeRange.min, t - 30); second < t; second += 1) {
      const secondRows = this.adjustedRowsForTime(second).filter((row) => row.srcId === nodeId);
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
      const rows = this.adjustedRowsForTime(second).filter((row) => row.srcId === nodeId);
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

  updateRouterLocation(nodeIdInput, { lat: latInput, lon: lonInput, t: tInput } = {}) {
    const node = this.requireRouter(nodeIdInput);
    const { lat, lon } = parseLatLon(latInput, lonInput);
    const t = this.normalizeTime(tInput);
    const frozenTraffic = this.trafficByTime.get(t)?.perNode[node.id] ?? null;

    node.lat = lat;
    node.lon = lon;
    node.locationOverridden = true;
    node.positionUpdatedAtT = t;
    node.relocationDistanceKm = haversineDistanceKm(node.homeLat, node.homeLon, lat, lon) ?? 0;

    if (node.planType === 'FIXED') {
      this.refreshFixedRouterStatus(node, t, frozenTraffic);
    } else {
      node.suspended = false;
      node.suspendedSinceT = null;
      node.frozenTraffic = null;
      node.status = 'ALLOWED';
    }

    this.trafficByTime = this.precomputeTraffic();
    return this.nodeFrame(node.id, t).node;
  }

  resetRouterLocation(nodeIdInput) {
    const node = this.requireRouter(nodeIdInput);
    node.lat = node.homeLat;
    node.lon = node.homeLon;
    node.locationOverridden = false;
    node.positionUpdatedAtT = null;
    node.relocationDistanceKm = 0;
    node.suspended = false;
    node.suspendedSinceT = null;
    node.frozenTraffic = null;
    node.status = node.planType === 'MOBILITY' ? 'ALLOWED' : 'INSIDE';
    this.trafficByTime = this.precomputeTraffic();
    return this.nodeFrame(node.id, this.timeRange.min).node;
  }

  updateRouterPlan(nodeIdInput, planTypeInput, tInput = this.timeRange.min) {
    const node = this.requireRouter(nodeIdInput);
    const t = this.normalizeTime(tInput);
    node.planType = normalizePlanType(planTypeInput);

    if (node.planType === 'MOBILITY') {
      node.suspended = false;
      node.suspendedSinceT = null;
      node.frozenTraffic = null;
      node.status = 'ALLOWED';
    } else if (node.locationOverridden) {
      this.refreshFixedRouterStatus(node, t, this.trafficByTime.get(t)?.perNode[node.id] ?? null);
    } else {
      node.suspended = false;
      node.suspendedSinceT = null;
      node.frozenTraffic = null;
      node.status = 'INSIDE';
    }

    this.trafficByTime = this.precomputeTraffic();
    return this.nodeFrame(node.id, t).node;
  }

  updateRouterMac(nodeIdInput, macAddress) {
    const node = this.requireRouter(nodeIdInput);
    const verifiedMac = this.verification.verifyMac(node.id, macAddress);
    node.macAddress = verifiedMac;
    return {
      node: node.baseSnapshot(),
      verified: true
    };
  }

  refreshFixedRouterStatus(node, t, frozenTraffic = null) {
    if (!node.locationOverridden) {
      node.suspended = false;
      node.suspendedSinceT = null;
      node.frozenTraffic = null;
      node.status = 'INSIDE';
      return;
    }

    if (node.relocationDistanceKm > FIXED_RADIUS_KM) {
      const wasSuspended = node.suspended;
      node.suspended = true;
      node.suspendedSinceT = t;
      node.frozenTraffic = frozenTraffic ? { ...frozenTraffic } : null;
      node.status = 'SUSPENDED';
      if (!wasSuspended) this.recordViolation(node, 'FIXED_GEOFENCE');
      return;
    }

    node.suspended = false;
    node.suspendedSinceT = null;
    node.frozenTraffic = null;
    node.status = 'INSIDE';
  }

  recordViolation(node, reason) {
    this.violations.unshift({
      device_id: String(node.id),
      timestamp: new Date().toISOString(),
      dist_km: round(node.relocationDistanceKm, 3),
      reason
    });
    this.violations = this.violations.slice(0, 100);
  }

  getViolations(limitInput = 50) {
    const limit = clamp(Number(limitInput) || 50, 1, 100);
    return this.violations.slice(0, limit);
  }

  requireRouter(nodeIdInput) {
    const node = this.nodes.get(Number(nodeIdInput));
    if (!node || node.type !== 'router') {
      const error = new Error(`Unknown router id: ${nodeIdInput}`);
      error.statusCode = 404;
      throw error;
    }
    return node;
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
      const rows = this.adjustedRowsForTime(t);
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

      for (const node of this.nodes.values()) {
        if (
          node.type === 'router' &&
          node.suspended &&
          node.frozenTraffic &&
          node.suspendedSinceT != null &&
          t >= node.suspendedSinceT
        ) {
          cumulative.set(node.id, { ...node.frozenTraffic });
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

function parseLatLon(latInput, lonInput) {
  const lat = Number(latInput);
  const lon = Number(lonInput);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    const error = new Error('Latitude must be a number between -90 and 90');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    const error = new Error('Longitude must be a number between -180 and 180');
    error.statusCode = 400;
    throw error;
  }
  return { lat, lon };
}
