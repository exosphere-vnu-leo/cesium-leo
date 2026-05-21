import { useEffect, useMemo, useState } from 'react';
import { Activity, CloudRain, Radio, Router, Satellite, Wifi } from 'lucide-react';
import CesiumGlobe from './components/CesiumGlobe.jsx';
import ControlDock from './components/ControlDock.jsx';
import MetricCard from './components/MetricCard.jsx';
import QualityBadge from './components/QualityBadge.jsx';
import Sparkline from './components/Sparkline.jsx';
import { formatBytes, formatTime, getJson } from './lib/api.js';

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
          setTime(data.timeRange.min);
          setSelectedNodeId(data.nodes[0]?.id ?? null);
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
  }, []);

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
  }, [started, time]);

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
  }, [started, selectedNodeId, time]);

  const timeRange = manifest?.timeRange ?? { min: 0, max: 0 };
  const selectedNode = useMemo(
    () => manifest?.nodes.find((node) => node.id === Number(selectedNodeId)),
    [manifest, selectedNodeId]
  );

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
        <button className={activeTab === 'node' ? 'active' : ''} onClick={() => setActiveTab('node')}>
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

function SystemDashboard({ frame, manifest }) {
  const nodes = frame?.nodes ?? manifest?.nodes ?? [];
  const totals = frame?.totals;

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
                <span className="node-satellite">{node.primarySatelliteName ?? 'No sat'}</span>
              </div>
            ))}
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

function NodeDashboard({ manifest, frame, nodeFrame, selectedNodeId, onNodeChange }) {
  const node = nodeFrame?.node;
  const traffic = node?.traffic;
  const rain = nodeFrame?.rainIndicator;

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
        {node ? <QualityBadge quality={node.quality} sinr={node.sinrDlDb} /> : null}
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
            detail={nodeFrame?.antenna ? `${nodeFrame.antenna.rangeKm} km range` : 'No primary'}
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
            <span>next satellite and link quality</span>
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
