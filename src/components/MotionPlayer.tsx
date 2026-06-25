import React, { useState, useRef, useCallback, useEffect } from 'react';
import { URDFRobot } from 'urdf-loader';

/**
 * Motion frame structure as parsed from the JSON files (e.g., 006.json.txt).
 * Each array element is one motion frame - playback is frame-by-frame.
 */
interface MotionFrame {
  right?: { JOINTS: Record<string, number> };
  left?: { JOINTS: Record<string, number> };
}

interface MotionPlayerProps {
  robot: URDFRobot | null;
  _existingJointValues?: Record<string, number>;
  onJointChange?: (name: string, value: number) => void;
}

const MotionPlayer: React.FC<MotionPlayerProps> = ({
  robot,
  onJointChange,
}) => {
  const [motionFrames, setMotionFrames] = useState<MotionFrame[]>([]);
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // Animation state - using frame index instead of time
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [speed, setSpeed] = useState(30); // FPS for playback speed
  const [loop, setLoop] = useState(true);
  const [unit, setUnit] = useState<'deg' | 'rad'>('deg');
  
  // New features
  const [bypassedJoints, setBypassedJoints] = useState<Set<string>>(new Set()); // Joints to bypass in motion playback
  const [xOffset, setXOffset] = useState(0); // X-axis translation offset

  // Animation reference using timestamp-based frame advancement
  const animFrameRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);

  // Extract joint names from robot for bypass selector
  const robotJointNames = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (robot) {
      const names = new Set<string>();
      Object.values(robot.joints).forEach(j => {
        if (j.jointType !== 'fixed') {
          names.add(j.name);
        }
      });
      robotJointNames.current = names;
    }
  }, [robot]);

  // Load motion JSON file via drag & drop or file picker
  const loadMotionFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.json') && !file.name.endsWith('.txt')) return;
    setIsLoadingFile(true);

    try {
      const text = await file.text();
      // Parse JSON array with commas between entries (format like 006.json.txt)
      let parsed: MotionFrame[];
      try {
        parsed = JSON.parse(text);
      } catch {
        // Try to fix the format - join comma-separated entries
        const cleaned = text.replace(/\n\s*,\s*\n/g, ',').replace(/^\s*,/, '').replace(/,\s*$/, '');
        parsed = JSON.parse(cleaned);
      }

      if (!Array.isArray(parsed)) {
        alert('Invalid motion file format.');
        return;
      }

      // Validate frames have JOINTS data
      const validFrames = parsed.filter(f => f.right?.JOINTS || f.left?.JOINTS);
      if (validFrames.length === 0) {
        alert('No valid joint frames found in file.');
        return;
      }

      setMotionFrames(parsed);
      setCurrentFrame(0);
      setIsPlaying(false);
    } catch (err) {
      console.error('Failed to load motion file:', err);
      alert('Failed to parse motion file.');
    } finally {
      setIsLoadingFile(false);
    }
  }, []);

  // Compute average joint values from a frame (merge right + left sides)
  const getFrameJointValues = useCallback((frame: MotionFrame): Record<string, number> => {
    const values: Record<string, number> = {};
    if (frame.right?.JOINTS) {
      Object.assign(values, frame.right.JOINTS);
    }
    if (frame.left?.JOINTS) {
      for (const [k, v] of Object.entries(frame!.left!.JOINTS)) {
        // Average left/right values
        if (values[k] !== undefined) {
          values[k] = (values[k] + v) / 2;
        } else {
          values[k] = v;
        }
      }
    }
    return values;
  }, []);

  // Apply joint values to robot at current frame position (respects bypassed joints)
  const applyFrameValues = useCallback((frameIdx_: number, values: Record<string, number>) => {
    if (!robot) return;
    
    // Filter out bypassed joints - don't update their values during motion playback
    const filteredValues = Object.entries(values).filter(([name]) => !bypassedJoints.has(name));
    
    for (const [name, angle] of filteredValues) {
      robot.setJointValue(name, angle);
      onJointChange?.(name, angle);
    }
    
    // Apply x-offset translation to the entire robot
    if (xOffset !== 0) {
      robot.position.x = xOffset;
    }
  }, [robot, onJointChange, bypassedJoints, xOffset]);

  // Apply joint values from the current frame index to the robot
  const applyCurrentFrame = useCallback(() => {
    if (motionFrames.length === 0) return;
    const frame = motionFrames[currentFrame];
    if (!frame || (!frame.right?.JOINTS && !frame.left?.JOINTS)) return;
    
    const values = getFrameJointValues(frame);
    applyFrameValues(currentFrame, values);
  }, [motionFrames, currentFrame, getFrameJointValues, applyFrameValues]);

  // Animation loop using FPS-based frame advancement (continues even with bypassed joints)
  const animate = useCallback((timestamp: number) => {
    if (!isPlaying || !robot) return;

    // Calculate elapsed time since last frame
    const elapsedMs = timestamp - lastFrameTimeRef.current;
    const msPerFrame = 1000 / speed;

    // Only advance to next frame when enough time has passed
    if (elapsedMs >= msPerFrame) {
      let nextFrame = currentFrame + 1;
      
      // Handle looping or stopping at end
      if (nextFrame >= motionFrames.length) {
        if (loop) {
          nextFrame = 0;
        } else {
          setIsPlaying(false);
          nextFrame = motionFrames.length - 1;
        }
      }

      setCurrentFrame(nextFrame);
      applyCurrentFrame();
      
      // Update time reference for next calculation
      lastFrameTimeRef.current = timestamp;
    }

    animFrameRef.current = requestAnimationFrame(animate);
  }, [isPlaying, robot, speed, loop, currentFrame, motionFrames.length, applyCurrentFrame]);

  useEffect(() => {
    if (isPlaying) {
      lastFrameTimeRef.current = performance.now();
      // Apply first frame immediately when starting
      applyCurrentFrame();
      animFrameRef.current = requestAnimationFrame(animate);
    } else {
      cancelAnimationFrame(animFrameRef.current);
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, animate]);

  // Controls - frame-based navigation
  const togglePlayPause = useCallback(() => {
    if (motionFrames.length === 0) return;
    setIsPlaying(!isPlaying);
  }, [isPlaying, motionFrames.length]);

  const stepForward = useCallback(() => {
    if (motionFrames.length === 0) return;
    let nextFrame = currentFrame + 1;
    if (nextFrame >= motionFrames.length) {
      nextFrame = loop ? 0 : motionFrames.length - 1;
    }
    setCurrentFrame(nextFrame);
    applyCurrentFrame();
  }, [motionFrames, currentFrame, loop, applyCurrentFrame]);

  const stepBackward = useCallback(() => {
    if (motionFrames.length === 0) return;
    let prevFrame = currentFrame - 1;
    if (prevFrame < 0) {
      prevFrame = loop ? motionFrames.length - 1 : 0;
    }
    setCurrentFrame(prevFrame);
    applyCurrentFrame();
  }, [motionFrames, currentFrame, loop, applyCurrentFrame]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newFrame = parseInt(e.target.value, 10);
    if (isNaN(newFrame) || newFrame < 0 || newFrame >= motionFrames.length) return;
    setCurrentFrame(newFrame);
    applyCurrentFrame();
  }, [motionFrames, applyCurrentFrame]);

  // File drop handlers
  const [isDragOver, setIsDragOver] = useState(false);

  const _handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file)
        loadMotionFile(file);
  }, [loadMotionFile]);

  // File input ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modern color palette
  const colors = {
    background: motionFrames.length === 0 ? '#1a1a1e' : '#23272f',
    border: motionFrames.length === 0 ? 'rgba(80, 90, 110, 0.5)' : 'rgba(100, 150, 255, 0.2)',
    accent: '#4fc3f7',
    accentDisabled: '#6b7280',
    textPrimary: motionFrames.length === 0 ? '#9ca3af' : '#ffffff',
    textSecondary: motionFrames.length === 0 ? '#6b7280' : '#a1a1aa',
    cardBg: '#15191f',
    buttonHover: motionFrames.length === 0 ? 'rgba(100, 116, 139, 0.3)' : 'rgba(79, 195, 247, 0.2)',
  };

  return (
      
    <div className="motion-player" style={{
      margin: '1.5rem 0',
      padding: motionFrames.length === 0 ? '2rem' : '1.5rem',
      border: `1px solid ${colors.border}`,
      borderRadius: '16px',
      background: `linear-gradient(145deg, ${colors.background}, #0d0f14)`,
      boxShadow: motionFrames.length === 0 ? 'none' : '0 8px 32px rgba(0, 0, 0, 0.4)',
      opacity: motionFrames.length === 0 ? 0.5 : 1,
      filter: motionFrames.length === 0 ? 'grayscale(60%) brightness(90%)' : undefined,
      transition: 'all 0.3s ease',
    }}>
      <h3 style={{
        margin: '0 0 1.5rem 0',
        fontSize: '1.3rem',
        fontWeight: 700,
        color: colors.textPrimary,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>🎬 Motion Player</h3>

      {/* Empty state / disabled placeholder */}
      {motionFrames.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '3rem 2rem',
          background: colors.cardBg,
          borderRadius: '16px',
          border: `2px dashed ${colors.border}`,
          marginBottom: '1.5rem',
          opacity: 0.8,
        }}>
          {isLoadingFile ? (
            <p style={{ color: colors.accent, fontSize: '1em', margin: 0 }}>Loading motion file...</p>
          ) : (
            <>
              <p style={{ color: colors.textSecondary, fontSize: '1.1em', margin: '0 0 1rem 0' }}>No motion file loaded</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '14px 28px',
                  cursor: 'pointer',
                  background: colors.accent,
                  color: '#000',
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '1em',
                  fontWeight: 700,
                  transition: 'all 0.2s ease',
                }}
              >
                📂 Load Motion File
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.txt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadMotionFile(file);
                }}
                style={{ display: 'none' }}
              />
              <p style={{ color: colors.textSecondary, fontSize: '0.9em', margin: '1rem 0 0 0' }}>Drop a JSON motion file or click to browse</p>
            </>
          )}
        </div>
      )}

      {/* File loading */}
      {motionFrames.length > 0 && !isLoadingFile && (
        <div style={{ marginBottom: '1.5rem' }}>
          {isDragOver ? (
            <p style={{ color: colors.accent, textAlign: 'center', fontSize: '1em' }}>Drop motion JSON file here</p>
          ) : (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoadingFile}
                style={{
                  padding: '10px 20px',
                  cursor: isLoadingFile ? 'wait' : 'pointer',
                  background: '#3a3a45',
                  color: colors.textPrimary,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '8px',
                }}
              >
                {isLoadingFile ? 'Loading...' : '📂 Load Motion File'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.txt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadMotionFile(file);
                }}
                style={{ display: 'none' }}
              />
            </>
          )}

          <span style={{ marginLeft: '1rem', color: colors.textSecondary, fontSize: '0.95em' }}>
            {motionFrames.length} frames
          </span>
        </div>
      )}

      {/* Playback controls */}
      {motionFrames.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Main transport controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={stepBackward}
              title="Previous Frame"
              style={{
                padding: '8px 14px',
                background: '#3a3a45',
                color: colors.textPrimary,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1.2em',
              }}
            >⏪</button>

            <button
              onClick={togglePlayPause}
              style={{
                padding: '10px 24px',
                fontSize: '1.5em',
                background: isPlaying ? '#ff5722' : colors.accent,
                color: '#fff',
                border: 'none',
                borderRadius: '10px',
                cursor: 'pointer',
                fontWeight: 700,
                minWidth: '60px',
              }}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            <button
              onClick={stepForward}
              title="Next Frame"
              style={{
                padding: '8px 14px',
                background: '#3a3a45',
                color: colors.textPrimary,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1.2em',
              }}
            >⏩</button>

            {/* Frame seek */}
            <span style={{
              minWidth: '90px',
              color: colors.textPrimary,
              fontFamily: 'monospace',
              fontWeight: 700,
              fontSize: '1em',
            }}>
              {currentFrame + 1}/{motionFrames.length}
            </span>

            <input
              type="range"
              min={0}
              max={motionFrames.length - 1}
              step={1}
              value={currentFrame}
              onChange={handleSeek}
              style={{ flex: 1, minWidth: '150px' }}
            />

            {/* Speed (FPS) */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: colors.textSecondary, fontSize: '0.9em' }}>FPS:</span>
              <select
                value={speed}
                onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
                style={{
                  marginLeft: '4px',
                  marginRight: '8px',
                  padding: '6px 10px',
                  background: '#23272f',
                  color: colors.textPrimary,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '6px',
                }}
              >
                {[10, 15, 20, 30, 40, 60].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            {/* Loop */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: colors.textSecondary }}>
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
              />
              <span style={{ fontSize: '0.9em' }}>Loop</span>
            </label>

            {/* Unit selector */}
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as 'deg' | 'rad')}
              style={{ marginLeft: '12px', padding: '6px 10px', background: '#23272f', color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '6px' }}
              title="Joint value display unit"
            >
              <option value="deg">Degrees (°)</option>
              <option value="rad">Radians</option>
            </select>
          </div>

          {/* Advanced options - Bypassed joints, X-offset */}
          {(robot || xOffset !== 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap', fontSize: '0.9em' }}>
              {/* Bypassed joints selector */}
              {robot && (
                <div style={{ color: colors.textSecondary }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <input
                      type="checkbox"
                      checked={bypassedJoints.size > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          // Add all joints to bypass when checking the main box
                          setBypassedJoints(new Set([...robotJointNames.current]));
                        } else {
                          // Clear all bypassed joints
                          setBypassedJoints(new Set());
                        }
                      }}
                    />
                    <span style={{ fontSize: '0.95em' }}>Bypass All Joints</span>
                  </label>
                  {(
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {Array.from(robotJointNames.current).map(jointName => (
                        <label key={jointName} style={{ fontSize: '0.8em', cursor: 'pointer', background: bypassedJoints.has(jointName) ? '#ff5722' : '#3a3a45', color: bypassedJoints.has(jointName) ? '#fff' : colors.textSecondary, padding: '4px 8px', borderRadius: '6px' }}>
                          <input
                            type="checkbox"
                            checked={bypassedJoints.has(jointName)}
                            onChange={(e) => {
                              const newSet = new Set(bypassedJoints);
                              if (e.target.checked) {
                                newSet.add(jointName);
                              } else {
                                newSet.delete(jointName);
                              }
                              setBypassedJoints(newSet);
                            }}
                          />
                          {' '}{jointName}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* X-offset slider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.9em', color: colors.textSecondary }}>X:</span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={xOffset}
                  onChange={(e) => setXOffset(parseFloat(e.target.value))}
                  style={{ width: '100px' }}
                />
                <span style={{ fontSize: '0.85em', color: colors.textSecondary, minWidth: '40px' }}>
                  {xOffset.toFixed(2)}m
                </span>
              </div>

              {/* Joint value summary */}
              <details style={{ fontSize: '0.9em', color: colors.textSecondary }}>
                <summary style={{ cursor: 'pointer' }}>Current Joint Values</summary>
                {(() => {
                  const frame = motionFrames[currentFrame];
                  if (!frame) return null;
                  const vals = getFrameJointValues(frame);
                  return (
                    <pre style={{ margin: '0.5rem 0', padding: '0.75rem', background: '#15191f', borderRadius: '8px' }}>
                      {Object.entries(vals)
                        .map(([k, v]) => {
                          const degVal = (v * 180 / Math.PI).toFixed(2);
                          const radVal = v.toFixed(4);
                          return `${k}: ${degVal}° | ${radVal} rad`;
                        })
                        .join('\n')}
                    </pre>
                  );
                })()}
              </details>
                <details style={{ fontSize: '0.9em', color: colors.textSecondary }}>
                    <summary style={{ cursor: 'pointer' }}>Current Json Values</summary>
                    {(() => {
                        const frame = motionFrames[currentFrame];
                        if (!frame) return null;
                        const vals = (frame);
                        return (
                            <p style={{ margin: '0.5rem 0', padding: '0.75rem', background: '#15191f', borderRadius: '8px' }}>
                      {JSON.stringify(vals)}
                    </p>
                        );
                    })()}
                </details>
            </div>
          )}

        </div>
      )}

      {/* Drop zone overlay */}
      {isDragOver && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(79,195,247,0.1)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ fontSize: '2em', color: '#4fc3f7' }}>Drop Motion File Here</p>
        </div>
      )}
    </div>
  );
};

export default MotionPlayer;