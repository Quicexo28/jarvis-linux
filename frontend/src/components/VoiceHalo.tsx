interface VoiceHaloProps {
  active: boolean;
  audioLevel: number;
  state: 'capturing' | 'processing';
}

export function VoiceHalo({ active, audioLevel, state }: VoiceHaloProps) {
  if (!active) return null;

  const haloScale = 1 + audioLevel * 1.5;
  const haloOpacity = 0.4 + audioLevel * 0.5;
  const coreScale = 1 + audioLevel * 0.4;

  const dynamicHaloStyle =
    state === 'capturing'
      ? {
          transform: `scale(${haloScale})`,
          opacity: haloOpacity,
        }
      : undefined;

  const dynamicCoreStyle =
    state === 'capturing'
      ? {
          transform: `scale(${coreScale})`,
        }
      : undefined;

  return (
    <div className={`voice-halo ${state === 'processing' ? 'voice-halo--processing' : ''}`}>
      <div className="voice-halo__halo" style={dynamicHaloStyle} />
      <div className="voice-halo__core" style={dynamicCoreStyle} />
    </div>
  );
}
