import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const storageKey = 'pi-hub.session-display-order.v1';
function readOrder(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === 'string').slice(0, 20000)
      : [];
  } catch {
    return [];
  }
}
/** Display order belongs to this Hub profile; native records and their timestamps are untouched. */
export function useSessionOrder(list: RefObject<HTMLUListElement | null>) {
  const [order, setOrder] = useState(readOrder),
    before = useRef<Map<string, number> | null>(null);
  const animations = useRef<Animation[]>([]);
  function arrange<T extends { key: string }>(rows: T[]): T[] {
    const positions = new Map(order.map((key, index) => [key, index]));
    return [...rows].sort(
      (a, b) => (positions.get(a.key) ?? order.length) - (positions.get(b.key) ?? order.length),
    );
  }
  function move(source: string, target: string, keys: string[]) {
    if (source === target || !keys.includes(source) || !keys.includes(target)) return;
    before.current = new Map(
      Array.from(list.current?.querySelectorAll<HTMLElement>('[data-session-key]') ?? []).map(
        (el) => [el.dataset.sessionKey!, el.getBoundingClientRect().top],
      ),
    );
    const next = keys.filter((key) => key !== source);
    next.splice(keys.indexOf(target), 0, source);
    setOrder((previous) => {
      const included = new Set(next),
        known = new Set(previous),
        combined = [...previous, ...keys.filter((key) => !known.has(key))];
      let index = 0;
      const result = combined
        .map((key) => (included.has(key) ? next[index++] : key))
        .slice(0, 20000);
      try {
        localStorage.setItem(storageKey, JSON.stringify(result));
      } catch {
        /* The active order remains usable when profile storage is unavailable. */
      }
      return result;
    });
  }
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (!previous) return;
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !list.current) return;
    const style = getComputedStyle(document.documentElement),
      motion = style.getPropertyValue('--move').trim(),
      milliseconds = parseFloat(motion) * (motion.endsWith('ms') ? 1 : 1000),
      duration = Number.isFinite(milliseconds) ? milliseconds : 220,
      easing = style.getPropertyValue('--ease-out').trim();
    const changed = Array.from(
      list.current.querySelectorAll<HTMLElement>('[data-session-key]'),
    ).map((el) => ({
      el,
      delta:
        (previous.get(el.dataset.sessionKey!) ?? el.getBoundingClientRect().top) -
        el.getBoundingClientRect().top,
    }));
    animations.current = changed
      .filter(({ delta }) => Math.abs(delta) > 1)
      .map(({ el, delta }) =>
        el.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
          duration,
          easing,
        }),
      );
  }, [order]);
  useLayoutEffect(() => () => animations.current.forEach((animation) => animation.cancel()), []);
  return { arrange, move };
}
