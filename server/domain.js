import * as satellite from 'satellite.js';
import {
  average,
  canonicalNodeName,
  nodeTypeFromName,
  normalizeLongitude,
  qualityFromSinr,
  roleLabel,
  round
} from './utils.js';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export class Satellite {
  constructor({ id, name, line1, line2 }) {
    this.id = id;
    this.name = name;
    this.line1 = line1;
    this.line2 = line2;
    this.noradId = Number(line1.slice(2, 7));
    this.satrec = satellite.twoline2satrec(line1, line2);
    this.positionCache = new Map();
  }

  positionAt(startDate, t) {
    const second = Math.round(t);
    const cacheKey = `${startDate.getTime()}:${second}`;
    if (this.positionCache.has(cacheKey)) return this.positionCache.get(cacheKey);

    const date = new Date(startDate.getTime() + second * 1000);
    const propagated = satellite.propagate(this.satrec, date);
    if (!propagated?.position) {
      const failed = {
        id: this.id,
        name: this.name,
        lat: null,
        lon: null,
        altKm: null,
        error: this.satrec.error ?? 'propagation_failed'
      };
      this.positionCache.set(cacheKey, failed);
      return failed;
    }

    const gmst = satellite.gstime(date);
    const geodetic = satellite.eciToGeodetic(propagated.position, gmst);
    const position = {
      id: this.id,
      name: this.name,
      planeId: Math.floor(this.id / 10) + 1,
      slotInPlane: (this.id % 10) + 1,
      lat: round(geodetic.latitude * RAD_TO_DEG, 4),
      lon: round(normalizeLongitude(geodetic.longitude * RAD_TO_DEG), 4),
      altKm: round(geodetic.height, 2),
      timestamp: date.toISOString()
    };

    this.positionCache.set(cacheKey, position);
    return position;
  }

  lookAnglesFrom(node, startDate, t) {
    const second = Math.round(t);
    const date = new Date(startDate.getTime() + second * 1000);
    const propagated = satellite.propagate(this.satrec, date);
    if (!propagated?.position) return null;

    const gmst = satellite.gstime(date);
    const observerGd = {
      longitude: node.lon * DEG_TO_RAD,
      latitude: node.lat * DEG_TO_RAD,
      height: 0
    };
    const positionEcf = satellite.eciToEcf(propagated.position, gmst);
    const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);
    return {
      satId: this.id,
      satName: this.name,
      azimuthDeg: round(lookAngles.azimuth * RAD_TO_DEG, 2),
      elevationDeg: round(lookAngles.elevation * RAD_TO_DEG, 2),
      rangeKm: round(lookAngles.rangeSat, 1),
      visible: lookAngles.elevation > 0
    };
  }
}

export class NetworkNode {
  constructor({ id, name, canonicalName, lat, lon, minElevationDeg }) {
    this.id = id;
    this.name = name;
    this.canonicalName = canonicalName ?? canonicalNodeName(name);
    this.type = nodeTypeFromName(this.canonicalName);
    this.lat = lat;
    this.lon = lon;
    this.homeLat = lat;
    this.homeLon = lon;
    this.homeRadiusKm = null;
    this.planType = null;
    this.status = 'ACTIVE';
    this.locationOverridden = false;
    this.positionUpdatedAtT = null;
    this.relocationDistanceKm = 0;
    this.suspended = false;
    this.suspendedSinceT = null;
    this.minElevationDeg = minElevationDeg ?? 0;
  }

  baseSnapshot() {
    return {
      id: this.id,
      name: this.name,
      canonicalName: this.canonicalName,
      type: this.type,
      lat: this.lat,
      lon: this.lon,
      homeLat: this.homeLat,
      homeLon: this.homeLon,
      homeRadiusKm: this.homeRadiusKm,
      planType: this.planType,
      status: this.status,
      suspended: this.suspended,
      relocationDistanceKm: round(this.relocationDistanceKm, 3),
      macAddress: this.macAddress ?? null,
      minElevationDeg: this.minElevationDeg
    };
  }

  summarizeRoutes(routes, traffic = null) {
    const primary = choosePrimaryRoute(routes);
    const role = nodeRoleLabel(this.type);
    const avgSinr = average(routes.map((route) => route.sinrDlDb));
    const quality = qualityFromSinr(avgSinr);
    const uplinkLossDb = average(routes.map((route) => route.fsplUlDb + route.atmUlDb));
    const downlinkLossDb = average(routes.map((route) => route.fsplDlDb + route.atmDlDb));

    return {
      ...this.baseSnapshot(),
      alive: routes.length > 0,
      activeSatelliteCount: new Set(routes.map((route) => route.nextHopSatId)).size,
      routeCount: routes.length,
      primarySatelliteId: primary?.nextHopSatId ?? null,
      primarySatelliteName: primary?.satName ?? null,
      elevationDeg: round(primary?.elevationUlDeg ?? null, 2),
      role,
      uplinkLossDb: round(uplinkLossDb, 2),
      downlinkLossDb: round(downlinkLossDb, 2),
      sinrDlDb: round(avgSinr, 2),
      quality,
      traffic: traffic ?? { sentBytes: 0, receivedBytes: 0, failedBytes: 0 }
    };
  }
}

export class Gateway extends NetworkNode {
  constructor(args) {
    super(args);
    this.type = 'gateway';
    this.status = 'ACTIVE';
  }
}

export class Router extends NetworkNode {
  constructor(args) {
    super(args);
    this.type = 'router';
    this.planType = normalizePlanType(args.planType ?? defaultRouterPlan(args.id));
    this.homeLat = this.lat;
    this.homeLon = this.lon;
    this.homeRadiusKm = 0.5;
    this.status = this.planType === 'MOBILITY' ? 'ALLOWED' : 'INSIDE';
    this.macAddress = args.macAddress ?? deterministicMacAddress(this.id, this.canonicalName);
    this.originalMacAddress = this.macAddress;
    this.hardwareSerial = args.hardwareSerial ?? `VNU-LEO-${String(this.id).padStart(3, '0')}`;
  }
}

export function choosePrimaryRoute(routes) {
  return [...routes].sort((left, right) => {
    const sinrDelta = (right.sinrDlDb ?? -Infinity) - (left.sinrDlDb ?? -Infinity);
    if (sinrDelta !== 0) return sinrDelta;
    return (right.elevationUlDeg ?? -Infinity) - (left.elevationUlDeg ?? -Infinity);
  })[0];
}

function nodeRoleLabel(type) {
  return type === 'router' ? 'UT (29.5GHz/19.7GHz)' : 'GW (27.5GHz/17.7GHz)';
}

export function normalizePlanType(planType) {
  const value = String(planType ?? '').trim().toUpperCase();
  if (value === 'FIXED' || value === 'MOBILITY') return value;
  const error = new Error(`Unsupported plan type: ${planType}`);
  error.statusCode = 400;
  throw error;
}

function defaultRouterPlan(id) {
  return Number(id) % 2 === 0 ? 'MOBILITY' : 'FIXED';
}

function deterministicMacAddress(id, name) {
  let hash = 2166136261;
  const source = `${id}:${name}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = [0x02];
  for (let index = 0; index < 5; index += 1) {
    bytes.push((hash >>> (index * 5)) & 0xff);
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
