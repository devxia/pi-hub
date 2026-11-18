import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';

type Workspace = 'local' | 'remote';
type Boundary = 'left' | 'right';
type Widths = { left: number; right: number };
type Preference = { wide?: Widths; narrow?: number };
type Drag = {
  boundary: Boundary;
  pointerId: number;
  handle: HTMLDivElement;
  x: number;
  start: Widths;
};

const leftMin = 168;
const leftMax = 320;
const limits = { local: { middle: 360, right: 360 }, remote: { middle: 320, right: 300 } };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
const widthValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function readPreference(key: string): Preference {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return {
      wide: widthValue(saved?.wide?.left) && widthValue(saved?.wide?.right) ? saved.wide : undefined,
      narrow: widthValue(saved?.narrow) ? saved.narrow : undefined,
    };
  } catch {
    return {};
  }
}

function paneWidths(kind: Workspace, width: number, narrow: boolean, preference: Preference): Widths {
  const { middle, right: rightMin } = limits[kind];
  const stockLeft = narrow ? (kind === 'local' ? 188 : 180) : kind === 'local' && width <= 1250 ? 188 : 208;
  const wantedLeft = (narrow ? preference.narrow ?? preference.wide?.left : preference.wide?.left) ?? stockLeft;
  const left = clamp(wantedLeft, leftMin, Math.min(leftMax, width - middle - (narrow ? 0 : rightMin)));
  if (narrow) return { left, right: 0 };

  const stockRight = kind === 'remote' ? width * 0.34 : (width - stockLeft) * (width <= 1250 ? 9 / 19 : 582 / 1232);
  const right = clamp(preference.wide?.right ?? stockRight, rightMin, width - left - middle);
  return { left, right };
}

function subscribeToResize(notify: () => void) {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
}

function windowWidth() {
  return window.innerWidth;
}

export function useWorkspaceViewport() {
  const width = useSyncExternalStore(subscribeToResize, windowWidth);
  return { width, narrow: width <= 1050 };
}

export function WorkspaceColumns({
  kind,
  viewport: { width, narrow },
  blocked = false,
  children: [navigation, list, detail],
}: {
  kind: Workspace;
  viewport: ReturnType<typeof useWorkspaceViewport>;
  blocked?: boolean;
  children: [ReactNode, ReactNode, ReactNode];
}) {
  const storageKey = `pi-hub.workspace-widths.${kind}.v1`;
  const [preference, setPreference] = useState(() => readPreference(storageKey));
  const [dragWidths, setDragWidths] = useState<Widths | null>(null);
  const drag = useRef<Drag | null>(null);
  const widths = dragWidths ?? paneWidths(kind, width, narrow, preference);

  function release() {
    const current = drag.current;
    drag.current = null;
    if (current?.handle.hasPointerCapture(current.pointerId)) {
      current.handle.releasePointerCapture(current.pointerId);
    }
    return current;
  }

  useLayoutEffect(() => {
    setDragWidths(null);
    return () => { release(); };
  }, [width, blocked]);

  function save(next: Preference) {
    setPreference(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // The current layout stays usable if profile storage is unavailable.
    }
  }

  function commit(next: Widths) {
    save(narrow ? { ...preference, narrow: next.left } : { ...preference, wide: next });
  }

  function range(boundary: Boundary, start: Widths) {
    const { middle, right } = limits[kind];
    return boundary === 'left'
      ? { min: leftMin, max: Math.min(leftMax, width - start.right - middle), value: start.left }
      : { min: middle, max: width - start.left - right, value: width - start.left - start.right };
  }

  function move(boundary: Boundary, start: Widths, delta: number): Widths {
    const { min, max, value } = range(boundary, start);
    const next = clamp(value + delta, min, max);
    return boundary === 'left' ? { ...start, left: next } : { ...start, right: width - start.left - next };
  }

  function update(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setDragWidths(move(current.boundary, current.start, event.clientX - current.x));
  }

  function finish(event: PointerEvent<HTMLDivElement>, accepted: boolean) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    release();
    setDragWidths(null);
    if (!accepted || width !== windowWidth()) return;
    const next = move(current.boundary, current.start, event.clientX - current.x);
    if (next.left !== current.start.left || next.right !== current.start.right) commit(next);
  }

  function resizeWithKey(event: KeyboardEvent<HTMLDivElement>, boundary: Boundary) {
    if (drag.current) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        release();
        setDragWidths(null);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      save({});
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const { min, max, value } = range(boundary, widths);
    const delta = event.key === 'Home' ? min - value : event.key === 'End' ? max - value : event.key === 'ArrowLeft' ? -12 : 12;
    const next = move(boundary, widths, delta);
    if (next.left !== widths.left || next.right !== widths.right) commit(next);
  }

  function separator(boundary: Boundary) {
    const { min, max, value } = range(boundary, widths);
    return (
      <div
        className={`workspace-separator workspace-separator-${boundary}`}
        role="separator"
        aria-label={boundary === 'left' ? '调整导航与列表宽度' : '调整列表与详情宽度'}
        aria-orientation="vertical"
        aria-controls={`${kind}-${boundary === 'left' ? 'navigation' : 'list'}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} 像素`}
        title="拖动调整宽度，双击恢复默认。也可用左右键调整，Enter 恢复默认。"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { boundary, pointerId: event.pointerId, handle: event.currentTarget, x: event.clientX, start: widths };
          setDragWidths(widths);
        }}
        onPointerMove={update}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onLostPointerCapture={(event) => finish(event, false)}
        onKeyDown={(event) => resizeWithKey(event, boundary)}
        onDoubleClick={() => {
          release();
          setDragWidths(null);
          save({});
        }}
      />
    );
  }

  return (
    <div
      className={`${kind === 'local' ? 'workspace' : 'remote-workspace'} workspace-columns${narrow ? ' workspace-columns-narrow' : ''}${dragWidths ? ' workspace-columns-dragging' : ''}`}
      style={{ '--workspace-left': `${widths.left}px`, '--workspace-right': `${widths.right}px` } as CSSProperties}
    >
      {navigation}
      {!blocked && separator('left')}
      {list}
      {!blocked && !narrow && separator('right')}
      {detail}
    </div>
  );
}
