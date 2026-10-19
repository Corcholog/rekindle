// The Rekindle mark: a coal with a spark rising from it. Same drawing as public/favicon.svg and
// the extension icons (scripts/build-icons.ts).
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path d="M6 22.5c0-4.6 4.4-8.3 10-8.3s10 3.7 10 8.3c0 2.9-4.4 4.8-10 4.8S6 25.4 6 22.5z" fill="var(--ink, #1b1e21)" />
      <path d="M10.5 23c0-2.6 2.5-4.6 5.5-4.6s5.5 2 5.5 4.6c0 1.4-2.5 2.2-5.5 2.2s-5.5-.8-5.5-2.2z" fill="var(--ember, #b8410f)" />
      <path d="M16 3.5c2.6 3 3.9 5.4 3.9 7.4a3.9 3.9 0 0 1-7.8 0c0-1.3.6-2.5 1.6-3.6.2 1.2.8 2 1.6 2.3-.5-2.1-.2-4.2.7-6.1z" fill="var(--ember-hot, #e2731c)" />
    </svg>
  );
}
