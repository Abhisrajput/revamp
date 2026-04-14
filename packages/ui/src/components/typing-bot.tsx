

/**
 * Animated bot typing on a keyboard.
 * Detailed SVG with shading, depth, and smooth animations.
 */

interface TypingBotProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  centered?: boolean;
}

const SIZES = {
  sm: 80,
  md: 140,
  lg: 220,
  xl: 320,
};

export function TypingBot({ size = 'xl', className = '', centered = true }: TypingBotProps) {
  const width = SIZES[size];
  const height = Math.round(width * 0.95);

  return (
    <div
      className={`${centered ? 'flex flex-col items-center justify-center w-full' : ''} ${className}`}
    >
      <svg
        viewBox="0 0 200 190"
        xmlns="http://www.w3.org/2000/svg"
        width={width}
        height={height}
        className="overflow-visible"
      >
        <defs>
          {/* Bot body gradient — brushed metal/orange */}
          <linearGradient id="body-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#fb923c" />
            <stop offset="50%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#c2410c" />
          </linearGradient>
          <linearGradient id="body-side" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9a3412" />
            <stop offset="50%" stopColor="#c2410c" />
            <stop offset="100%" stopColor="#9a3412" />
          </linearGradient>

          {/* Screen gradient */}
          <linearGradient id="screen-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#020617" />
          </linearGradient>
          <linearGradient id="screen-glow" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#0891b2" stopOpacity="0.1" />
          </linearGradient>

          {/* Keyboard gradient */}
          <linearGradient id="kb-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#64748b" />
            <stop offset="50%" stopColor="#475569" />
            <stop offset="100%" stopColor="#334155" />
          </linearGradient>
          <linearGradient id="kb-front" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>

          {/* Desk shadow */}
          <radialGradient id="ground-shadow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#000" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>

          {/* Eye glow filter */}
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ─── Floor shadow under everything ──────────────────────── */}
        <ellipse cx="100" cy="180" rx="75" ry="6" fill="url(#ground-shadow)" />

        {/* ─── Keyboard (back to front for depth) ─────────────────── */}
        {/* Keyboard front edge */}
        <path
          d="M 25 165 L 175 165 L 168 175 L 32 175 Z"
          fill="url(#kb-front)"
        />
        {/* Keyboard top */}
        <path
          d="M 25 145 L 175 145 L 175 165 L 25 165 Z"
          fill="url(#kb-grad)"
          stroke="#1e293b"
          strokeWidth="0.6"
        />

        {/* Key rows */}
        <g>
          {/* Row 1 */}
          {Array.from({ length: 14 }).map((_, i) => {
            const x = 30 + i * 10;
            const blinkClass = i % 4 === 0 ? 'key-blink-1' : i % 4 === 1 ? 'key-blink-2' : i % 4 === 2 ? 'key-blink-3' : '';
            return (
              <g key={`r1-${i}`}>
                <rect x={x} y="148" width="8" height="6" rx="1" fill="#1e293b" />
                <rect x={x + 0.5} y="148.5" width="7" height="5" rx="0.8" fill="#334155" className={blinkClass} />
              </g>
            );
          })}
          {/* Row 2 */}
          {Array.from({ length: 14 }).map((_, i) => {
            const x = 32 + i * 10;
            const blinkClass = i % 4 === 1 ? 'key-blink-1' : i % 4 === 2 ? 'key-blink-2' : i % 4 === 3 ? 'key-blink-3' : '';
            return (
              <g key={`r2-${i}`}>
                <rect x={x} y="155" width="8" height="6" rx="1" fill="#1e293b" />
                <rect x={x + 0.5} y="155.5" width="7" height="5" rx="0.8" fill="#334155" className={blinkClass} />
              </g>
            );
          })}
          {/* Spacebar */}
          <rect x="62" y="162" width="76" height="3" rx="1" fill="#1e293b" />
          <rect x="62.5" y="162.5" width="75" height="2" rx="0.8" fill="#334155" />
        </g>

        {/* ─── Bot body with subtle bobbing animation ───────────────── */}
        <g className="bot-bob">
          {/* Antenna */}
          <line x1="100" y1="20" x2="100" y2="32" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
          <circle cx="100" cy="17" r="3.5" fill="#fbbf24" stroke="#d97706" strokeWidth="0.6" className="antenna-blink" />
          <circle cx="100" cy="17" r="1.5" fill="#fef3c7" />

          {/* Neck/body connector */}
          <rect x="92" y="98" width="16" height="6" rx="1" fill="#9a3412" />
          <rect x="92" y="98" width="16" height="2" rx="1" fill="#7c2d12" />

          {/* Shoulders/torso (small chest piece for arms to attach to) */}
          <path
            d="M 70 100 Q 70 95 75 95 L 125 95 Q 130 95 130 100 L 130 130 Q 130 135 125 135 L 75 135 Q 70 135 70 130 Z"
            fill="url(#body-grad)"
            stroke="#9a3412"
            strokeWidth="0.8"
          />
          {/* Chest detail panel */}
          <rect x="85" y="105" width="30" height="20" rx="3" fill="#7c2d12" />
          {/* Status lights on chest */}
          <circle cx="92" cy="115" r="1.8" fill="#22c55e" className="status-blink-1" />
          <circle cx="100" cy="115" r="1.8" fill="#f59e0b" className="status-blink-2" />
          <circle cx="108" cy="115" r="1.8" fill="#ef4444" className="status-blink-3" />

          {/* Head — main body */}
          {/* Head shadow side */}
          <path
            d="M 60 35 Q 60 28 67 28 L 133 28 Q 140 28 140 35 L 140 90 Q 140 97 133 97 L 67 97 Q 60 97 60 90 Z"
            fill="url(#body-grad)"
            stroke="#9a3412"
            strokeWidth="0.8"
          />
          {/* Head highlight */}
          <path
            d="M 65 33 Q 65 30 68 30 L 132 30 Q 135 30 135 33 L 135 38 Q 100 35 65 38 Z"
            fill="#fb923c"
            opacity="0.5"
          />

          {/* Side ear/speakers */}
          <rect x="55" y="50" width="6" height="20" rx="2" fill="url(#body-side)" stroke="#9a3412" strokeWidth="0.5" />
          <rect x="139" y="50" width="6" height="20" rx="2" fill="url(#body-side)" stroke="#9a3412" strokeWidth="0.5" />
          <line x1="56" y1="55" x2="60" y2="55" stroke="#451a03" strokeWidth="0.5" />
          <line x1="56" y1="58" x2="60" y2="58" stroke="#451a03" strokeWidth="0.5" />
          <line x1="56" y1="61" x2="60" y2="61" stroke="#451a03" strokeWidth="0.5" />
          <line x1="56" y1="64" x2="60" y2="64" stroke="#451a03" strokeWidth="0.5" />
          <line x1="140" y1="55" x2="144" y2="55" stroke="#451a03" strokeWidth="0.5" />
          <line x1="140" y1="58" x2="144" y2="58" stroke="#451a03" strokeWidth="0.5" />
          <line x1="140" y1="61" x2="144" y2="61" stroke="#451a03" strokeWidth="0.5" />
          <line x1="140" y1="64" x2="144" y2="64" stroke="#451a03" strokeWidth="0.5" />

          {/* Screen face — recessed look */}
          <rect x="68" y="40" width="64" height="48" rx="6" fill="#0f172a" />
          <rect x="69" y="41" width="62" height="46" rx="5" fill="url(#screen-grad)" />
          {/* Screen reflection */}
          <rect x="69" y="41" width="62" height="20" rx="5" fill="url(#screen-glow)" opacity="0.3" />

          {/* Eyes */}
          <g className="eyes" filter="url(#glow)">
            {/* Left eye */}
            <circle cx="86" cy="60" r="6" fill="#0e7490" />
            <circle cx="86" cy="60" r="4.5" fill="#22d3ee" />
            <circle cx="87" cy="58" r="1.5" fill="#a5f3fc" />
            {/* Right eye */}
            <circle cx="114" cy="60" r="6" fill="#0e7490" />
            <circle cx="114" cy="60" r="4.5" fill="#22d3ee" />
            <circle cx="115" cy="58" r="1.5" fill="#a5f3fc" />
          </g>

          {/* Mouth — animated data flow */}
          <g className="mouth">
            <rect x="88" y="74" width="24" height="3" rx="1.5" fill="#0e7490" />
            <rect x="90" y="75" width="3" height="1" rx="0.5" fill="#22d3ee" className="data-flow-1" />
            <rect x="95" y="75" width="3" height="1" rx="0.5" fill="#22d3ee" className="data-flow-2" />
            <rect x="100" y="75" width="3" height="1" rx="0.5" fill="#22d3ee" className="data-flow-3" />
            <rect x="105" y="75" width="3" height="1" rx="0.5" fill="#22d3ee" className="data-flow-1" />
          </g>

          {/* Bolts/screws on head corners */}
          <circle cx="65" cy="35" r="1.2" fill="#451a03" />
          <circle cx="135" cy="35" r="1.2" fill="#451a03" />
          <circle cx="65" cy="92" r="1.2" fill="#451a03" />
          <circle cx="135" cy="92" r="1.2" fill="#451a03" />
        </g>

        {/* ─── Arms (in front of body, animated) ───────────────────── */}
        {/* Left arm — typing */}
        <g className="arm-left">
          {/* Upper arm */}
          <line x1="73" y1="115" x2="60" y2="135" stroke="#c2410c" strokeWidth="6" strokeLinecap="round" />
          {/* Elbow joint */}
          <circle cx="60" cy="135" r="3.5" fill="#9a3412" stroke="#7c2d12" strokeWidth="0.5" />
          {/* Forearm */}
          <line x1="60" y1="135" x2="55" y2="148" stroke="#c2410c" strokeWidth="5" strokeLinecap="round" />
          {/* Hand */}
          <ellipse cx="55" cy="151" rx="4" ry="3" fill="#f97316" stroke="#9a3412" strokeWidth="0.6" />
          {/* Tiny fingers */}
          <line x1="53" y1="153" x2="52" y2="155" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="55" y1="154" x2="55" y2="156" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="57" y1="153" x2="58" y2="155" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
        </g>

        {/* Right arm — typing (offset) */}
        <g className="arm-right">
          <line x1="127" y1="115" x2="140" y2="135" stroke="#c2410c" strokeWidth="6" strokeLinecap="round" />
          <circle cx="140" cy="135" r="3.5" fill="#9a3412" stroke="#7c2d12" strokeWidth="0.5" />
          <line x1="140" y1="135" x2="145" y2="148" stroke="#c2410c" strokeWidth="5" strokeLinecap="round" />
          <ellipse cx="145" cy="151" rx="4" ry="3" fill="#f97316" stroke="#9a3412" strokeWidth="0.6" />
          <line x1="143" y1="153" x2="142" y2="155" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="145" y1="154" x2="145" y2="156" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="147" y1="153" x2="148" y2="155" stroke="#9a3412" strokeWidth="0.8" strokeLinecap="round" />
        </g>

        {/* ─── Floating code particles ───────────────────────────── */}
        <g className="particles">
          <text x="35" y="100" fontSize="6" fill="#22d3ee" opacity="0" className="particle-1" fontFamily="monospace">
            {'{ }'}
          </text>
          <text x="160" y="100" fontSize="6" fill="#a5f3fc" opacity="0" className="particle-2" fontFamily="monospace">
            {'< />'}
          </text>
          <text x="40" y="60" fontSize="5" fill="#67e8f9" opacity="0" className="particle-3" fontFamily="monospace">
            {'( )'}
          </text>
          <text x="155" y="55" fontSize="5" fill="#22d3ee" opacity="0" className="particle-4" fontFamily="monospace">
            {';;'}
          </text>
        </g>

        <style>{`
          /* Bot bobbing — smooth gentle motion */
          .bot-bob {
            animation: bob 3s ease-in-out infinite;
            transform-origin: 100px 90px;
          }
          @keyframes bob {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-2px) rotate(0.3deg); }
          }

          /* Antenna light pulsing */
          .antenna-blink {
            animation: antenna-pulse 1.5s ease-in-out infinite;
            transform-origin: 100px 17px;
          }
          @keyframes antenna-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.85); }
          }

          /* Eyes — occasional natural blink */
          .eyes {
            animation: eye-blink 5s ease-in-out infinite;
            transform-origin: 100px 60px;
          }
          @keyframes eye-blink {
            0%, 88%, 100% { transform: scaleY(1); }
            93% { transform: scaleY(0.05); }
            96% { transform: scaleY(1); }
          }

          /* Status lights on chest */
          .status-blink-1 { animation: status 1.2s ease-in-out infinite; }
          .status-blink-2 { animation: status 1.2s ease-in-out infinite 0.4s; }
          .status-blink-3 { animation: status 1.2s ease-in-out infinite 0.8s; }
          @keyframes status {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }

          /* Mouth data flow */
          .data-flow-1 { animation: data 0.8s ease-in-out infinite; }
          .data-flow-2 { animation: data 0.8s ease-in-out infinite 0.2s; }
          .data-flow-3 { animation: data 0.8s ease-in-out infinite 0.4s; }
          @keyframes data {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 1; }
          }

          /* Left arm typing */
          .arm-left {
            animation: type-left 0.45s ease-in-out infinite;
            transform-origin: 73px 115px;
          }
          @keyframes type-left {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-2.5px) rotate(-2deg); }
          }

          /* Right arm typing (offset) */
          .arm-right {
            animation: type-right 0.45s ease-in-out infinite 0.225s;
            transform-origin: 127px 115px;
          }
          @keyframes type-right {
            0%, 100% { transform: translateY(0) rotate(0deg); }
            50% { transform: translateY(-2.5px) rotate(2deg); }
          }

          /* Key flashes */
          .key-blink-1 { animation: key-flash 0.6s ease-in-out infinite; }
          .key-blink-2 { animation: key-flash 0.6s ease-in-out infinite 0.2s; }
          .key-blink-3 { animation: key-flash 0.6s ease-in-out infinite 0.4s; }
          @keyframes key-flash {
            0%, 100% { fill: #334155; }
            50% { fill: #06b6d4; }
          }

          /* Code particles floating up */
          .particle-1 { animation: float-up 4s ease-out infinite; }
          .particle-2 { animation: float-up 4s ease-out infinite 1s; }
          .particle-3 { animation: float-up 4s ease-out infinite 2s; }
          .particle-4 { animation: float-up 4s ease-out infinite 3s; }
          @keyframes float-up {
            0% { opacity: 0; transform: translateY(0); }
            15% { opacity: 0.9; }
            85% { opacity: 0.9; }
            100% { opacity: 0; transform: translateY(-30px); }
          }
        `}</style>
      </svg>
    </div>
  );
}
