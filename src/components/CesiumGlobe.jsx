import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const COLOR = {
  gateway: '#14f1d9',
  router: '#ff7ab6',
  satellite: '#ffd447',
  inactive: '#78716c',
  good: '#22c55e',
  fair: '#facc15',
  poor: '#f97316',
  critical: '#ef4444',
  unknown: '#a8a29e',
  trail: '#fbbf24',
  vietnam: '#2dd4bf'
};

const VIETNAM_VIEW = Cesium.Rectangle.fromDegrees(92.5, 3.5, 123.5, 29.5);
const VIETNAM_FOCUS = Cesium.Rectangle.fromDegrees(101.4, 7.2, 110.8, 23.9);
const TRACKING_VIEW_LIMITS = {
  west: 62,
  east: 148,
  south: -18,
  north: 38
};
const MIN_RENDER_SIZE = 64;

if (import.meta.env.VITE_CESIUM_ION_TOKEN) {
  Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
}

export default function CesiumGlobe({ mode, frame, nodeFrame, selectedNodeId }) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const focusKeyRef = useRef('');
  const resizeObserverRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || viewerRef.current) return undefined;

    let cancelled = false;
    let retryTimer;

    const initViewer = () => {
      if (cancelled || viewerRef.current) return;
      if (!isRenderable(container)) {
        retryTimer = window.setTimeout(initViewer, 80);
        return;
      }

      const viewer = createViewer(container);
      viewerRef.current = viewer;
      resizeObserverRef.current = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect || rect.width < MIN_RENDER_SIZE || rect.height < MIN_RENDER_SIZE) return;
        safeResize(viewer);
        safeRequestRender(viewer);
      });
      resizeObserverRef.current.observe(container);
    };

    initViewer();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy();
      }
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const container = containerRef.current;
    if (!viewer || !container || !isRenderable(container)) return;

    viewer.entities.removeAll();
    addVietnamFocus(viewer);

    if (mode === 'node' && nodeFrame) {
      drawNodeScene(viewer, nodeFrame);
      focusOnNodeScene(viewer, nodeFrame, focusKeyRef);
      safeRequestRender(viewer);
      return;
    }

    if (frame) {
      drawSystemScene(viewer, frame);
      focusOnSystemFrame(viewer, frame, focusKeyRef);
      safeRequestRender(viewer);
    }
  }, [mode, frame, nodeFrame, selectedNodeId]);

  return (
    <div className="cesium-shell">
      <div className="cesium-host" ref={containerRef} data-testid="cesium-host" />
      <div className="map-hud">
        <strong>{mode === 'node' ? 'Node Tactical View' : 'Vietnam Network View'}</strong>
        <span>Projection: satellite ground track</span>
        <div className="map-legend">
          <span><i className="legend-dot gateway" /> Gateway</span>
          <span><i className="legend-dot router" /> UT / Router</span>
        </div>
      </div>
    </div>
  );
}

function createViewer(container) {
  let baseLayer;
  try {
    baseLayer = Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
      )
    );
  } catch {
    baseLayer = undefined;
  }

  const viewer = new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    sceneMode: Cesium.SceneMode.SCENE2D,
    mapMode2D: Cesium.MapMode2D.ROTATE,
    showRenderLoopErrors: false,
    baseLayer
  });

  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#11120f');
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.screenSpaceCameraController.enableTilt = false;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 250000;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 9000000;
  viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.4);
  viewer.camera.setView({ destination: VIETNAM_VIEW });

  viewer.scene.renderError.addEventListener(() => {
    window.requestAnimationFrame(() => safeResize(viewer));
  });

  return viewer;
}

function drawSystemScene(viewer, frame) {
  const activeSatelliteIds = new Set(frame.links.map((link) => link.satelliteId));
  const linkCountBySatellite = new Map();
  for (const link of frame.links) {
    linkCountBySatellite.set(link.satelliteId, (linkCountBySatellite.get(link.satelliteId) ?? 0) + link.routeCount);
  }

  drawOrbitTrails(viewer, frame.orbitTrails ?? []);
  drawHandoverFocus(viewer, frame.handoverFocus);

  for (const sat of frame.satellites) {
    if (sat.lat == null || sat.lon == null) continue;
    addSatelliteEntity(viewer, sat, {
      idPrefix: 'sat-bg',
      background: true,
      active: activeSatelliteIds.has(sat.id)
    });
  }

  for (const sat of frame.trackedSatellites ?? []) {
    if (sat.lat == null || sat.lon == null) continue;
    addSatelliteEntity(viewer, sat, {
      idPrefix: 'sat-track',
      tracked: true,
      active: activeSatelliteIds.has(sat.id),
      routeCount: linkCountBySatellite.get(sat.id) ?? 0
    });
  }

  for (const link of frame.links) {
    const node = link.source;
    const sat = link.satellite;
    if (!node || !sat || sat.lat == null || sat.lon == null) continue;
    addLinkEntity(viewer, node, sat, link.quality?.level, link.routeCount);
  }

  for (const node of frame.nodes) {
    addNodeEntity(viewer, node, node.alive);
  }
}

function drawNodeScene(viewer, nodeFrame) {
  const node = nodeFrame.node;
  drawOrbitTrails(viewer, nodeFrame.orbitTrails ?? []);

  for (const sat of nodeFrame.visibleSatellites) {
    if (sat.position?.lat == null || sat.position?.lon == null) continue;
    const isPrimary = nodeFrame.primaryRoute?.satelliteId === sat.id;
    addSatelliteEntity(
      viewer,
      {
        id: sat.id,
        name: sat.name,
        lat: sat.position.lat,
        lon: sat.position.lon
      },
      {
        idPrefix: 'node-sat',
        active: sat.active,
        primary: isPrimary,
        routeCount: sat.routeCount,
        qualityLevel: sat.quality?.level,
        elevationDeg: sat.elevationDeg
      }
    );

    if (sat.active) {
      addLinkEntity(
        viewer,
        node,
        sat.position,
        sat.quality?.level,
        isPrimary ? 7 : Math.max(2, sat.routeCount),
        isPrimary
      );
    }
  }

  addNodeEntity(viewer, node, node.alive, true);
}

function addVietnamFocus(viewer) {
  viewer.entities.add({
    id: 'vietnam-focus-rectangle',
    rectangle: {
      coordinates: VIETNAM_FOCUS,
      fill: true,
      material: Cesium.Color.fromCssColorString(COLOR.vietnam).withAlpha(0.08),
      outline: false
    }
  });

  viewer.entities.add({
    id: 'vietnam-focus-outline',
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        101.4, 7.2,
        110.8, 7.2,
        110.8, 23.9,
        101.4, 23.9,
        101.4, 7.2
      ]),
      width: 2,
      clampToGround: true,
      material: Cesium.Color.fromCssColorString(COLOR.vietnam).withAlpha(0.65),
      zIndex: 1
    }
  });

  viewer.entities.add({
    id: 'vietnam-focus-label',
    position: Cesium.Cartesian3.fromDegrees(106.4, 24.4, 0),
    label: {
      text: 'VIETNAM FOCUS',
      font: '700 13px Inter, sans-serif',
      fillColor: Cesium.Color.fromCssColorString(COLOR.vietnam),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE
    }
  });
}

function drawOrbitTrails(viewer, trails) {
  for (const trail of trails) {
    const points = compactDatelinePath(trail.points ?? []);
    if (points.length < 2) continue;
    viewer.entities.add({
      id: `trail-${trail.satelliteId}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(points.flatMap((point) => [point.lon, point.lat])),
        width: 3,
        clampToGround: true,
        material: Cesium.Color.fromCssColorString(COLOR.trail).withAlpha(0.42),
        zIndex: 2
      }
    });
  }
}

function addSatelliteEntity(viewer, sat, options = {}) {
  const active = Boolean(options.active);
  const primary = Boolean(options.primary);
  const background = Boolean(options.background);
  const tracked = Boolean(options.tracked);
  const qualityLevel = options.qualityLevel ?? (active ? 'good' : 'unknown');
  const size = background ? (active ? 13 : 7) : primary ? 28 : active ? 24 : tracked ? 17 : 12;
  const color = active
    ? Cesium.Color.fromCssColorString(COLOR[qualityLevel] ?? COLOR.good)
    : Cesium.Color.fromCssColorString(background ? COLOR.satellite : COLOR.vietnam).withAlpha(
        background ? 0.45 : 0.9
      );
  const routeCount = Number(options.routeCount ?? 0);

  viewer.entities.add({
    id: `${options.idPrefix ?? 'sat'}-${sat.id}`,
    position: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, 0),
    point: {
      pixelSize: size,
      color,
      outlineWidth: primary ? 5 : active ? 4 : tracked ? 3 : 1,
      outlineColor: tracked && !active ? Cesium.Color.fromCssColorString(COLOR.vietnam) : Cesium.Color.BLACK,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: !background && (active || tracked)
      ? {
          text: satelliteLabel(sat, routeCount, { active, primary }),
          font: primary ? '800 15px Inter, sans-serif' : '700 13px Inter, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, primary ? -34 : -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      : undefined
  });
}

function drawHandoverFocus(viewer, handoverFocus) {
  for (const [index, event] of (handoverFocus?.upcoming ?? []).slice(0, 5).entries()) {
    const sat = event.newSatellitePosition;
    if (sat?.lat == null || sat?.lon == null) continue;
    viewer.entities.add({
      id: `handover-upcoming-${event.t}-${event.nodeId}-${event.newSatId}`,
      position: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, 0),
      ellipse: {
        semiMajorAxis: 90000 + index * 9000,
        semiMinorAxis: 90000 + index * 9000,
        material: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.08),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.75),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
      },
      label: {
        text: `NEXT ${formatClock(event.t)}\n${event.nodeName} → ${event.newSatName}`,
        font: '700 12px Inter, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#fbbf24'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, 30),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  }
}

function satelliteLabel(sat, routeCount, { active, primary }) {
  if (active) {
    return `${sat.name}\n${routeCount} routed flows`;
  }
  if (primary) return sat.name;
  return `${sat.name}\nplane ${sat.planeId ?? '?'} slot ${sat.slotInPlane ?? '?'}`;
}

function addNodeEntity(viewer, node, alive, selected = false) {
  const status = node.status ?? 'ACTIVE';
  const color = status === 'SUSPENDED' ? COLOR.critical : node.type === 'router' ? COLOR.router : COLOR.gateway;
  const labelSide = node.type === 'router' ? 1 : -1;
  const pointSize = selected ? 24 : 20;
  const ringSize = selected ? 36 : 33;
  const active = alive && status !== 'SUSPENDED' && status !== 'DISCONNECTED';
  viewer.entities.add({
    id: `node-ring-${node.id}`,
    position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 0),
    point: {
      pixelSize: ringSize,
      color: Cesium.Color.TRANSPARENT,
      outlineWidth: status === 'SUSPENDED' ? 7 : node.type === 'router' ? 5 : 6,
      outlineColor: Cesium.Color.fromCssColorString(active ? color : COLOR.inactive).withAlpha(0.9),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });

  viewer.entities.add({
    id: `node-${node.id}`,
    position: Cesium.Cartesian3.fromDegrees(node.lon, node.lat, 0),
    point: {
      pixelSize: pointSize,
      color: Cesium.Color.fromCssColorString(active || status === 'SUSPENDED' ? color : COLOR.inactive),
      outlineWidth: selected ? 6 : 5,
      outlineColor: node.type === 'router' ? Cesium.Color.BLACK : Cesium.Color.WHITE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: node.name,
      font: selected ? '900 16px Inter, sans-serif' : '800 14px Inter, sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: node.type === 'router' ? Cesium.HorizontalOrigin.LEFT : Cesium.HorizontalOrigin.RIGHT,
      pixelOffset: new Cesium.Cartesian2(labelSide * (selected ? 42 : 36), selected ? -36 : -30),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });
}

function addLinkEntity(viewer, node, sat, qualityLevel, routeCount = 1, primary = false) {
  const color = Cesium.Color.fromCssColorString(COLOR[qualityLevel] ?? COLOR.unknown);
  viewer.entities.add({
    id: `link-${node.id}-${sat.id ?? sat.name ?? sat.lon}-${routeCount}`,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([node.lon, node.lat, sat.lon, sat.lat]),
      width: primary ? 7 : Math.min(7, 3 + routeCount * 0.45),
      clampToGround: true,
      arcType: Cesium.ArcType.GEODESIC,
      material: color.withAlpha(primary ? 0.9 : 0.68),
      zIndex: primary ? 8 : 4
    }
  });
}

function focusOnSystemFrame(viewer, frame, focusKeyRef) {
  const activeKey = (frame.trackedSatellites ?? [])
    .filter((sat) => sat.active)
    .map((sat) => sat.id)
    .sort((a, b) => a - b)
    .join('-');
  const key = `system-${activeKey}-${Math.floor((frame.t ?? 0) / 180)}`;
  if (focusKeyRef.current === key) return;
  focusKeyRef.current = key;
  safeResize(viewer);
  viewer.camera.setView({ destination: boundsForSystemFrame(frame) });
}

function focusOnNodeScene(viewer, nodeFrame, focusKeyRef) {
  const key = `node-${nodeFrame.node.id}-${nodeFrame.node.lat}-${nodeFrame.node.lon}`;
  if (focusKeyRef.current === key) return;
  focusKeyRef.current = key;
  safeResize(viewer);
  viewer.camera.setView({ destination: boundsForNodeFrame(nodeFrame) });
}

function boundsForNodeFrame(nodeFrame) {
  const points = [{ lat: nodeFrame.node.lat, lon: nodeFrame.node.lon }];
  for (const sat of nodeFrame.visibleSatellites ?? []) {
    if (sat.active && sat.position?.lat != null && sat.position?.lon != null) {
      points.push({ lat: sat.position.lat, lon: sat.position.lon });
    }
  }

  let west = Math.min(...points.map((point) => point.lon));
  let east = Math.max(...points.map((point) => point.lon));
  let south = Math.min(...points.map((point) => point.lat));
  let north = Math.max(...points.map((point) => point.lat));
  const minLonSpan = 10;
  const minLatSpan = 8;
  const lonPad = Math.max(3, (minLonSpan - (east - west)) / 2);
  const latPad = Math.max(2.5, (minLatSpan - (north - south)) / 2);

  west = Math.max(88, west - lonPad);
  east = Math.min(126, east + lonPad);
  south = Math.max(-2, south - latPad);
  north = Math.min(34, north + latPad);
  return Cesium.Rectangle.fromDegrees(west, south, east, north);
}

function compactDatelinePath(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || Math.abs(point.lon - previous.lon) < 80) {
      result.push(point);
    }
  }
  return result;
}

function boundsForSystemFrame(frame) {
  const points = [
    ...(frame.nodes ?? []).map((node) => ({ lat: node.lat, lon: node.lon })),
    ...(frame.trackedSatellites ?? [])
      .filter((sat) => inTrackingWindow(sat))
      .map((sat) => ({ lat: sat.lat, lon: sat.lon })),
    ...(frame.handoverFocus?.upcoming ?? [])
      .map((event) => event.newSatellitePosition)
      .filter((sat) => sat && inTrackingWindow(sat))
      .map((sat) => ({ lat: sat.lat, lon: sat.lon }))
  ].filter((point) => point.lat != null && point.lon != null);

  if (!points.length) return VIETNAM_VIEW;
  let west = Math.min(...points.map((point) => point.lon));
  let east = Math.max(...points.map((point) => point.lon));
  let south = Math.min(...points.map((point) => point.lat));
  let north = Math.max(...points.map((point) => point.lat));
  const lonSpan = east - west;
  const latSpan = north - south;
  const lonPad = Math.max(3.5, (42 - lonSpan) / 2);
  const latPad = Math.max(2.5, (20 - latSpan) / 2);

  west = Math.max(TRACKING_VIEW_LIMITS.west, west - lonPad);
  east = Math.min(TRACKING_VIEW_LIMITS.east, east + lonPad);
  south = Math.max(TRACKING_VIEW_LIMITS.south, south - latPad);
  north = Math.min(TRACKING_VIEW_LIMITS.north, north + latPad);
  return Cesium.Rectangle.fromDegrees(west, south, east, north);
}

function inTrackingWindow(point) {
  return (
    point.lat >= TRACKING_VIEW_LIMITS.south &&
    point.lat <= TRACKING_VIEW_LIMITS.north &&
    point.lon >= TRACKING_VIEW_LIMITS.west &&
    point.lon <= TRACKING_VIEW_LIMITS.east
  );
}

function formatClock(totalSeconds) {
  const value = Number(totalSeconds ?? 0);
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isRenderable(container) {
  const { width, height } = container.getBoundingClientRect();
  return width >= MIN_RENDER_SIZE && height >= MIN_RENDER_SIZE;
}

function safeResize(viewer) {
  try {
    const container = viewer.container;
    if (!container || !isRenderable(container)) return;
    viewer.resize();
  } catch {
    // Cesium may report a zero-size canvas during browser split/resize; the next valid resize fixes it.
  }
}

function safeRequestRender(viewer) {
  try {
    const container = viewer.container;
    if (!container || !isRenderable(container)) return;
    viewer.scene.requestRender();
  } catch {
    // Ignore transient render requests while layout is collapsing.
  }
}
