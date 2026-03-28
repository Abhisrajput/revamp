'use client';

import { useEffect } from 'react';

/**
 * Pipeline layout override — removes the dashboard's max-w-7xl / padding
 * constraints so that Mission Control can use the full viewport.
 *
 * On mount it mutates the parent <main> and its immediate child container
 * to disable scrolling, remove padding, and lift the width cap.
 * Everything is restored on unmount.
 */
export default function PipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    const main = document.querySelector('main');
    const container = main?.firstElementChild as HTMLElement | null;

    if (!main || !container) return;

    // ── Store originals ────────────────────────────────────────
    const origMain = {
      overflow: main.style.overflow,
    };
    const origContainer = {
      maxWidth: container.style.maxWidth,
      padding: container.style.padding,
      margin: container.style.margin,
      width: container.style.width,
      height: container.style.height,
    };

    // ── Override for full-viewport Mission Control ─────────────
    main.style.overflow = 'hidden';
    container.style.maxWidth = 'none';
    container.style.padding = '0';
    container.style.margin = '0';
    container.style.width = '100%';
    container.style.height = '100%';

    return () => {
      main.style.overflow = origMain.overflow;
      container.style.maxWidth = origContainer.maxWidth;
      container.style.padding = origContainer.padding;
      container.style.margin = origContainer.margin;
      container.style.width = origContainer.width;
      container.style.height = origContainer.height;
    };
  }, []);

  return (
    <div className="h-full w-full overflow-hidden">
      {children}
    </div>
  );
}
