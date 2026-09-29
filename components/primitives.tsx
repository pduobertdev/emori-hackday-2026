import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ClockIcon } from "./icons";

export function Brand() {
  return (
    <div className="brand" aria-label="Emori">
      <span className="brand__mark" aria-hidden="true">
        <span>✺</span>
      </span>
      <span className="brand__name">emori</span>
    </div>
  );
}

type MemoryButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function MemoryButton({ className = "", ...props }: MemoryButtonProps) {
  return (
    <button className={`memory-button ${className}`} type="button" {...props}>
      <ClockIcon />
      <span>How Emori remembers</span>
    </button>
  );
}

export function Eyebrow({ children, warm = false }: { children: ReactNode; warm?: boolean }) {
  return <p className={`eyebrow${warm ? " eyebrow--warm" : ""}`}>{children}</p>;
}

export function CharacterHeading({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`character-heading${compact ? " character-heading--compact" : ""}`}>
      <Eyebrow>AI MEMORY EXPERIENCE</Eyebrow>
      <h1>Mateo</h1>
    </div>
  );
}
