import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CloudRain,
  MapPin,
  Radio,
  RotateCcw,
  Router,
  Satellite,
  Save,
  ShieldCheck,
  Wifi
} from 'lucide-react';
import CesiumGlobe from './components/CesiumGlobe.jsx';
import ControlDock from './components/ControlDock.jsx';
import MetricCard from './components/MetricCard.jsx';
import QualityBadge from './components/QualityBadge.jsx';
import Sparkline from './components/Sparkline.jsx';
import { formatBytes, formatTime, getJson, postJson } from './lib/api.js';

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [frame, setFrame] = useState(null);
  const [nodeFrame, setNodeFrame] = useState(null);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [activeTab, setActiveTab] = useState('system');
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer;
    let attempts = 0;

    const loadManifest = () => {
      attempts += 1;
      getJson('/api/manifest', controller.signal)
        .then((data) => {
          setError(null);
          setManifest(data);
          setTime((current) => current ?? data.timeRange.min);
          setSelectedNodeId((current) => current ?? data.nodes[0]?.id ?? null);
        })
        .catch((err) => {
          if (isAbortError(err, controller.signal)) return;
          if (attempts < 6) {
            retryTimer = window.setTimeout(loadManifest, 700);
            return;
          }
          setError(err.message);
        });
    };

    loadManifest();
    return () => {
      window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!started || !playing || !manifest) return undefined;
    const timer = window.setInterval(() => {
      setTime((current) => {
        const next = current + speed;
        return next > manifest.timeRange.max ? manifest.timeRange.min : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [started, playing, speed, manifest]);

  useEffect(() => {
    if (!started) return undefined;
    const controller = new AbortController();
    getJson(`/api/frame?t=${time}`, controller.signal)
      .then((data) => {
        setError(null);
        setFrame(data);
      })
      .catch((err) => {
        if (!isAbortError(err, controller.signal)) setError(err.message);
      });
    return () => controller.abort();
  }, [started, time, refreshKey]);

  useEffect(() => {
    if (!started || selectedNodeId == null) return undefined;
    const controller = new AbortController();
    getJson(`/api/nodes/${selectedNodeId}/frame?t=${time}`, controller.signal)
      .then((data) => {
        setError(null);
        setNodeFrame(data);
      })
      .catch((err) => {
        if (!isAbortError(err, controller.signal)) setError(err.message);
      });
    return () => controller.abort();
  }, [started, selectedNodeId, time, refreshKey]);

  const timeRange = manifest?.timeRange ?? { min: 0, max: 0 };
  const selectedNode = useMemo(
    () => manifest?.nodes.find((node) => node.id === Number(selectedNodeId)),
    [manifest, selectedNodeId]
  );
  const refreshDashboards = () => setRefreshKey((value) => value + 1);

  if (!started) {
    return (
      <main className="start-screen">
        <section className="start-panel">
          <div className="brand-row">
            <Satellite size={34} />
            <span>LEO Handover Simulation</span>
          </div>
          <h1>VNUSAT Gateway & Router Dashboard</h1>
          <div className="start-stats">
            <span>{manifest ? `${manifest.counts.nodes} nodes` : 'Loading nodes'}</span>
            <span>{manifest ? `${manifest.counts.satellites} satellites` : 'Loading TLE'}</span>
            <span>{manifest ? `${formatTime(manifest.timeRange.max + 1)} timeline` : 'Loading CSV'}</span>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <button
            className="start-button"
            disabled={!manifest}
            onClick={() => {
              setStarted(true);
              setPlaying(true);
            }}
          >
            Start
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">LEO Network</span>
          <h1>Handover Simulation</h1>
        </div>
        <div className="topbar-meta">
          <span>{frame?.simulationTime ?? manifest?.startDate}</span>
          <span>{formatTime(time)}</span>
        </div>
      </header>

      <nav className="tabs" aria-label="dashboard tabs">
        <button className={activeTab === 'system' ? 'active' : ''} onClick={() => setActiveTab('system')}>
          <Activity size={16} />
          System
        </button>
        <button
          className={activeTab === 'node' ? 'active' : ''}
          onClick={() => {
            setActiveTab('node');
            setSelectedNodeId((current) => {
              const currentNode = manifest?.nodes.find((item) => item.id === Number(current));
              if (currentNode?.type === 'router') return current;
              return manifest?.nodes.find((item) => item.type === 'router')?.id ?? current;
            });
          }}
        >
          <Radio size={16} />
          Router & Gateway
        </button>
      </nav>

      {activeTab === 'system' ? (
        <SystemDashboard frame={frame} manifest={manifest} />
      ) : (
        <NodeDashboard
          manifest={manifest}
          frame={frame}
          nodeFrame={nodeFrame}
          selectedNode={selectedNode}
          selectedNodeId={selectedNodeId}
          onNodeChange={setSelectedNodeId}
          time={time}
          onRefresh={refreshDashboards}
          onError={setError}
        />
      )}

      <ControlDock
        time={time}
        timeRange={timeRange}
        playing={playing}
        speed={speed}
        onPlayingChange={setPlaying}
        onSpeedChange={setSpeed}
        onTimeChange={setTime}
        onReset={() => {
          setPlaying(false);
          setTime(timeRange.min);
        }}
      />
    </main>
  );
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || /aborted/i.test(error?.message ?? '');
}

function formatPlanType(planType) {
  if (planType === 'MOBILITY') return 'Mobility';
  if (planType === 'FIXED') return 'Fixed';
  return 'n/a';
}

function statusLabel(status) {
  const labels = {
    ACTIVE: 'Active',
    INSIDE: 'Inside',
    ALLOWED: 'Allowed',
    SUSPENDED: 'Suspended',
    DISCONNECTED: 'Disconnected'
  };
  return labels[status] ?? status ?? 'n/a';
}

function statusClass(status) {
  return String(status ?? 'unknown').toLowerCase();
}

function formatDistanceKm(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(3)} km` : 'n/a';
}

function SystemDashboard({ frame, manifest }) {
  const nodes = frame?.nodes ?? manifest?.nodes ?? [];
  const totals = frame?.totals;
  const suspendedRouters = frame?.suspendedRouters ?? nodes.filter((node) => node.status === 'SUSPENDED');

  return (
    <section className="dashboard-grid system-grid" data-testid="system-dashboard">
      <div className="globe-panel">
        <CesiumGlobe mode="system" frame={frame} />
      </div>
      <aside className="side-panel">
        <div className="metric-grid">
          <MetricCard
            label="Active links"
            value={frame?.links?.length ?? 0}
            detail={`${frame?.nodes?.filter((node) => node.alive).length ?? 0}/${nodes.length} nodes alive`}
            icon={<Wifi size={18} />}
            tone="cyan"
          />
          <MetricCard
            label="Traffic sent"
            value={formatBytes(totals?.sentBytes ?? 0)}
            detail={`${formatBytes(totals?.receivedBytes ?? 0)} delivered`}
            icon={<Activity size={18} />}
            tone="green"
          />
          <MetricCard
            label="Suspended"
            value={suspendedRouters.length}
            detail="fixed geofence lock"
            icon={<AlertTriangle size={18} />}
            tone={suspendedRouters.length ? 'red' : 'default'}
          />
          <MetricCard
            label="Satellites"
            value={manifest?.counts.satellites ?? 0}
            detail={`${frame?.links?.reduce((sum, link) => sum + link.routeCount, 0) ?? 0} routed flows`}
            icon={<Satellite size={18} />}
            tone="amber"
          />
        </div>

        <section className="panel-block">
          <h2>Node Status</h2>
          <div className="node-list">
            {nodes.map((node) => (
              <div className="node-row" key={node.id}>
                <span className={`status-dot ${node.alive ? 'alive' : 'down'}`} />
                <div className="node-identity">
                  <strong>{node.name}</strong>
                  <small>{node.type}</small>
                </div>
                {node.planType ? <span className={`plan-pill ${node.planType.toLowerCase()}`}>{formatPlanType(node.planType)}</span> : null}
                <span className={`node-state ${statusClass(node.status)}`}>{statusLabel(node.status)}</span>
                <span className="node-satellite">{node.primarySatelliteName ?? 'No sat'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel-block">
          <div className="section-heading">
            <h2>Suspended Routers</h2>
            <span>{suspendedRouters.length} locked</span>
          </div>
          <div className="suspended-list">
            {suspendedRouters.length ? (
              suspendedRouters.map((node) => (
                <div className="suspended-row" key={node.id}>
                  <strong>{node.name}</strong>
                  <span>{formatDistanceKm(node.relocationDistanceKm)} from home</span>
                </div>
              ))
            ) : (
              <p className="empty-text">No suspended routers</p>
            )}
          </div>
        </section>

        <section className="panel-block">
          <h2>Tracked Satellite Plane</h2>
          <div className="sat-plane-list">
            {(frame?.trackedSatellites ?? []).map((sat) => (
              <div className={sat.active ? 'sat-plane-row active' : 'sat-plane-row'} key={sat.id}>
                <strong>{sat.name}</strong>
                <span>{sat.active ? `${sat.routeCount} flows` : `slot ${sat.slotInPlane}`}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel-block">
          <h2>Upcoming Handovers</h2>
          <div className="handover-list">
            {(frame?.handoverFocus?.upcoming ?? []).slice(0, 6).map((event) => (
              <div className="handover-row upcoming" key={`upcoming-${event.t}-${event.nodeId}-${event.oldSatId}-${event.newSatId}`}>
                <div className="handover-main">
                  <span className="handover-time">{formatTime(event.t)}</span>
                  <strong className="handover-title">{event.nodeName}</strong>
                </div>
                <em className="handover-event">next</em>
                <small className="handover-path">
                  {event.oldSatName ?? 'none'} → {event.newSatName ?? 'none'}
                </small>
              </div>
            ))}
          </div>
        </section>

        <section className="panel-block">
          <h2>Recent Handovers</h2>
          <div className="handover-list">
            {(frame?.recentHandovers ?? []).slice().reverse().map((event) => (
              <div className="handover-row" key={`${event.t}-${event.nodeId}-${event.oldSatId}-${event.newSatId}-${event.event}`}>
                <div className="handover-main">
                  <span className="handover-time">{formatTime(event.t)}</span>
                  <strong className="handover-title">{event.nodeName}</strong>
                </div>
                <em className="handover-event">{event.event}</em>
                <small className="handover-path">
                  {event.oldSatName ?? 'none'} → {event.newSatName ?? 'none'}
                </small>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}

function RouterRuntimePanel({ nodeFrame, time, onRefresh, onError }) {
  const node = nodeFrame?.node;
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [busyAction, setBusyAction] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!node) return;
    setLat(Number(node.lat).toFixed(4));
    setLon(Number(node.lon).toFixed(4));
    setMacAddress(node.macAddress ?? '');
    setMessage(null);
  }, [node?.id, node?.lat, node?.lon, node?.macAddress]);

  if (!node || node.type !== 'router') return null;

  const submitCoordinates = async (event) => {
    event.preventDefault();
    setBusyAction('coords');
    setMessage(null);
    try {
      await postJson(`/api/routers/${node.id}/location`, { lat: Number(lat), lon: Number(lon), t: time });
      setMessage({ type: 'success', text: 'Coordinates updated' });
      onRefresh?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      onError?.(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const resetLocation = async () => {
    setBusyAction('reset');
    setMessage(null);
    try {
      await postJson(`/api/routers/${node.id}/location/reset`, {});
      setMessage({ type: 'success', text: 'Location reset to home' });
      onRefresh?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      onError?.(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const switchPlan = async (planType) => {
    setBusyAction('plan');
    setMessage(null);
    try {
      await postJson(`/api/routers/${node.id}/plan`, { planType, t: time });
      setMessage({ type: 'success', text: `Plan switched to ${formatPlanType(planType)}` });
      onRefresh?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      onError?.(error.message);
    } finally {
      setBusyAction(null);
    }
  };

  const verifyMac = async (event) => {
    event.preventDefault();
    setBusyAction('mac');
    setMessage(null);
    try {
      await postJson(`/api/routers/${node.id}/mac`, { macAddress });
      setMessage({ type: 'success', text: 'MAC verified' });
      onRefresh?.();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="panel-block router-runtime">
      <div className="section-heading">
        <h2>Router Controls</h2>
        <span>{formatDistanceKm(node.relocationDistanceKm)} from home</span>
      </div>

      <div className="runtime-summary">
        <span>
          <MapPin size={15} />
          {Number(node.homeLat).toFixed(4)}, {Number(node.homeLon).toFixed(4)}
        </span>
        <span className={`node-state ${statusClass(node.status)}`}>{statusLabel(node.status)}</span>
      </div>

      <div className="plan-switch" aria-label="router plan controls">
        <button
          type="button"
          className={node.planType === 'FIXED' ? 'selected' : ''}
          onClick={() => switchPlan('FIXED')}
          disabled={busyAction === 'plan'}
        >
          Fixed
        </button>
        <button
          type="button"
          className={node.planType === 'MOBILITY' ? 'selected' : ''}
          onClick={() => switchPlan('MOBILITY')}
          disabled={busyAction === 'plan'}
        >
          Mobility
        </button>
      </div>

      <form className="runtime-form coord-form" onSubmit={submitCoordinates}>
        <label>
          Latitude
          <input type="number" step="0.0001" min="-90" max="90" value={lat} onChange={(event) => setLat(event.target.value)} />
        </label>
        <label>
          Longitude
          <input type="number" step="0.0001" min="-180" max="180" value={lon} onChange={(event) => setLon(event.target.value)} />
        </label>
        <div className="runtime-button-pair">
          <button type="submit" disabled={busyAction === 'coords'}>
            <Save size={16} />
            Update
          </button>
          <button type="button" onClick={resetLocation} disabled={busyAction === 'reset'}>
            <RotateCcw size={16} />
            Reset
          </button>
        </div>
      </form>

      <form className="runtime-form mac-form" onSubmit={verifyMac}>
        <label>
          MAC address
          <input value={macAddress} onChange={(event) => setMacAddress(event.target.value)} />
        </label>
        <button type="submit" disabled={busyAction === 'mac'}>
          <ShieldCheck size={16} />
          Verify
        </button>
      </form>

      {message ? <p className={`form-message ${message.type}`}>{message.text}</p> : null}
    </section>
  );
}

function RouterPickerPanel({ routers, selectedNodeId, onNodeChange }) {
  if (!routers.length) return null;

  return (
    <section className="panel-block router-picker-panel">
      <div className="section-heading">
        <h2>Router Controls</h2>
        <span>select a router</span>
      </div>
      <div className="router-shortcuts panel-shortcuts">
        {routers.map((router) => (
          <button
            key={router.id}
            type="button"
            className={Number(selectedNodeId) === router.id ? 'selected' : ''}
            onClick={() => onNodeChange(router.id)}
          >
            {router.name.replace('Router_', '')}
          </button>
        ))}
      </div>
    </section>
  );
}

function NodeDashboard({ manifest, frame, nodeFrame, selectedNodeId, onNodeChange, time, onRefresh, onError }) {
  const node = nodeFrame?.node;
  const traffic = node?.traffic;
  const rain = nodeFrame?.rainIndicator;
  const isRouter = node?.type === 'router';
  const routers = (manifest?.nodes ?? []).filter((item) => item.type === 'router');

  return (
    <section className="dashboard-grid node-grid" data-testid="node-dashboard">
      <div className="node-toolbar">
        <select value={selectedNodeId ?? ''} onChange={(event) => onNodeChange(Number(event.target.value))}>
          {(manifest?.nodes ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="router-shortcuts" aria-label="router shortcuts">
          {routers.map((router) => (
            <button
              key={router.id}
              type="button"
              className={Number(selectedNodeId) === router.id ? 'selected' : ''}
              onClick={() => onNodeChange(router.id)}
            >
              {router.name.replace('Router_', '')}
            </button>
          ))}
        </div>
        {node ? <QualityBadge quality={node.quality} sinr={node.sinrDlDb} /> : null}
        {node?.planType ? <span className={`plan-pill ${node.planType.toLowerCase()}`}>{formatPlanType(node.planType)}</span> : null}
        {node?.status ? <span className={`node-state ${statusClass(node.status)}`}>{statusLabel(node.status)}</span> : null}
        {rain?.active ? (
          <span className="rain-alert active">
            <CloudRain size={16} />
            Attenuation
          </span>
        ) : (
          <span className="rain-alert">
            <CloudRain size={16} />
            Clear
          </span>
        )}
      </div>

      <div className="globe-panel">
        <CesiumGlobe mode="node" frame={frame} nodeFrame={nodeFrame} selectedNodeId={selectedNodeId} />
      </div>

      <aside className="side-panel node-side">
        <div className="metric-grid">
          <MetricCard
            label="Role"
            value={node?.role ?? 'n/a'}
            detail={node?.type ?? ''}
            icon={node?.type === 'router' ? <Router size={18} /> : <Radio size={18} />}
            tone="cyan"
          />
          <MetricCard
            label="Primary Sat"
            value={node?.primarySatelliteName ?? 'n/a'}
            detail={
              nodeFrame?.antenna
                ? `${nodeFrame.antenna.rangeKm} km range · ${nodeFrame.antenna.elevationDeg}° elevation`
                : 'No primary'
            }
            icon={<Satellite size={18} />}
            tone="amber"
          />
          <MetricCard
            label="Traffic"
            value={formatBytes(traffic?.sentBytes ?? 0)}
            detail={`${formatBytes(traffic?.receivedBytes ?? 0)} downlink`}
            icon={<Activity size={18} />}
            tone="green"
          />
          <MetricCard
            label="Rain loss"
            value={`${rain?.atmUlDb ?? 'n/a'} / ${rain?.atmDlDb ?? 'n/a'} dB`}
            detail="UL / DL atmosphere"
            icon={<CloudRain size={18} />}
            tone={rain?.active ? 'red' : 'default'}
          />
        </div>

        {isRouter ? (
          <RouterRuntimePanel
            nodeFrame={nodeFrame}
            time={time}
            onRefresh={onRefresh}
            onError={onError}
          />
        ) : (
          <RouterPickerPanel routers={routers} selectedNodeId={selectedNodeId} onNodeChange={onNodeChange} />
        )}

        <section className="panel-block">
          <div className="section-heading">
            <h2>Loss & SINR</h2>
            <span>avg outgoing routes, last 60s</span>
          </div>
          <Sparkline
            series={nodeFrame?.lossSeries ?? []}
            keys={['uplinkLossDb', 'downlinkLossDb', 'sinrDlDb']}
            labels={{
              uplinkLossDb: 'Uplink',
              downlinkLossDb: 'Downlink',
              sinrDlDb: 'SINR'
            }}
            units={{
              uplinkLossDb: 'dB',
              downlinkLossDb: 'dB',
              sinrDlDb: 'dB'
            }}
            normalizeEach
          />
        </section>

        <section className="panel-block">
          <div className="section-heading">
            <h2>Active Routes</h2>
          </div>
          <div className="route-list">
            {(nodeFrame?.activeRoutes ?? []).map((route) => (
              <div className="route-row" key={`${route.dstId}-${route.satelliteId}`}>
                <div className="route-target">
                  <strong>to {route.dstName}</strong>
                  <small>via {route.satelliteName}</small>
                </div>
                <QualityBadge quality={route.quality} sinr={route.sinrDlDb} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel-block">
          <h2>Visible Satellites</h2>
          <div className="sat-chip-list">
            {(nodeFrame?.visibleSatellites ?? []).slice(0, 16).map((sat) => (
              <span className={sat.active ? 'sat-chip active' : 'sat-chip'} key={sat.id}>
                {sat.name}
              </span>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}
