// The logo from the mockups (M with two accent flicks).
export function MomentumMark({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 90" width={size} height={size * 0.75} fill="none" aria-hidden="true">
      <path d="M28 70V18L52 50L75 18V70" stroke="var(--ink)" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 80L34 74L28 66L18 80Z" fill="var(--accent)" />
      <path d="M66 22L76 14L82 22L66 22Z" fill="var(--accent)" />
    </svg>
  );
}
