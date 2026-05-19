import { Pause, Play, RotateCcw } from 'lucide-react';
import { formatTime } from '../lib/api.js';

export default function ControlDock({
  time,
  timeRange,
  playing,
  speed,
  onPlayingChange,
  onSpeedChange,
  onTimeChange,
  onReset
}) {
  return (
    <div className="control-dock" data-testid="control-dock">
      <button className="icon-button primary" onClick={() => onPlayingChange(!playing)}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <button className="icon-button" onClick={onReset}>
        <RotateCcw size={18} />
      </button>
      <div className="segmented">
        {[1, 2, 4].map((value) => (
          <button
            key={value}
            className={speed === value ? 'selected' : ''}
            onClick={() => onSpeedChange(value)}
          >
            {value}x
          </button>
        ))}
      </div>
      <div className="time-readout">{formatTime(time)}</div>
      <input
        className="time-slider"
        type="range"
        min={timeRange.min}
        max={timeRange.max}
        value={time}
        onChange={(event) => onTimeChange(Number(event.target.value))}
      />
      <div className="time-end">{formatTime(timeRange.max)}</div>
    </div>
  );
}
