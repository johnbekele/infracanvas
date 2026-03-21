interface LogoProps {
  className?: string;
  size?: number;
}

export function Logo({ className = '', size = 32 }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      width={size}
      height={size}
      className={className}
    >
      {/* Canvas/artboard frame */}
      <rect
        x="4"
        y="4"
        width="56"
        height="56"
        rx="8"
        stroke="url(#infracanvas-gradient)"
        strokeWidth="3"
        fill="none"
      />

      {/* Inner canvas area */}
      <rect
        x="10"
        y="10"
        width="44"
        height="44"
        rx="4"
        fill="url(#infracanvas-gradient)"
        opacity="0.1"
      />

      {/* Infrastructure nodes */}
      <circle cx="32" cy="18" r="6" fill="url(#infracanvas-gradient)" />
      <circle cx="20" cy="40" r="5" fill="url(#infracanvas-gradient)" />
      <circle cx="44" cy="40" r="5" fill="url(#infracanvas-gradient)" />
      <circle cx="32" cy="32" r="7" fill="url(#infracanvas-gradient)" />

      {/* Connection lines */}
      <path
        d="M32 24 L32 25"
        stroke="url(#infracanvas-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M27 30 L24 36"
        stroke="url(#infracanvas-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M37 30 L40 36"
        stroke="url(#infracanvas-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M25 40 L39 40"
        stroke="url(#infracanvas-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Inner icons on nodes */}
      <rect x="29" y="15" width="6" height="6" rx="1" fill="white" opacity="0.9" />
      <rect x="29" y="29" width="6" height="6" rx="1" fill="white" opacity="0.9" />
      <circle cx="20" cy="40" r="2" fill="white" opacity="0.9" />
      <circle cx="44" cy="40" r="2" fill="white" opacity="0.9" />

      <defs>
        <linearGradient id="infracanvas-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoIcon({ className = '', size = 32 }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      width={size}
      height={size}
      className={className}
    >
      <rect x="2" y="2" width="28" height="28" rx="6" fill="url(#infracanvas-icon-gradient)" />

      {/* Infrastructure nodes */}
      <circle cx="16" cy="10" r="3" fill="white" />
      <circle cx="10" cy="20" r="2.5" fill="white" opacity="0.85" />
      <circle cx="22" cy="20" r="2.5" fill="white" opacity="0.85" />
      <circle cx="16" cy="16" r="3.5" fill="white" />

      {/* Connections */}
      <path
        d="M16 13 L16 12.5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M13.5 15 L11.5 18"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M18.5 15 L20.5 18"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M12.5 20 L19.5 20"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />

      <defs>
        <linearGradient id="infracanvas-icon-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
    </svg>
  );
}
