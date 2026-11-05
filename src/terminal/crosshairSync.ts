// Crosshair sync across layout cells: the hovered chart publishes the bar time
// under its crosshair; every other chart shows a vertical line at that time.

type Listener = (source: number, time: number | null) => void;

const listeners = new Set<Listener>();

export function publishCrosshair(source: number, time: number | null) {
  for (const listener of listeners) listener(source, time);
}

export function subscribeCrosshair(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
