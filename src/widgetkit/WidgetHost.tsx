// The core's shell around one widget: its settings, size and visibility, and a boundary so a widget
// that throws doesn't take the screen down with it. The widget renders only with a session it supports.

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReplay } from "../store";
import { createVisibility, SettingsContext, SizeContext, VisibilityContext, type WidgetSize, type SettingsValue } from "./context";
import type { WidgetDefinition, WidgetSettings } from "./defineWidget";
import { sessionKind } from "./select";

export interface WidgetHostProps {
  // Any widget's settings type: the host only merges and stores them.
  widget: WidgetDefinition<any>;
  /** The user's settings for this widget (from the layout), on top of the definition's defaults. */
  settings?: Partial<WidgetSettings>;
  /** Called with the user's settings (not the defaults) whenever the widget changes them, for the layout to store. */
  onSettingsChange?: (settings: Partial<WidgetSettings>) => void;
  className?: string;
  style?: CSSProperties;
}

/** Catches a crashed widget; it gets another go when `resetKey` changes (another widget or other settings). */
class Boundary extends Component<{ name: string; resetKey: string; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error(`Widget "${this.props.name}" crashed`, error);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.error != null && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error == null) return this.props.children;
    return <div className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-400">{this.props.name} stopped working</div>;
  }
}

export function WidgetHost({ widget, settings: initial, onSettingsChange, className, style }: WidgetHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibility] = useState(createVisibility);
  const [size, setSize] = useState<WidgetSize>({ width: 0, height: 0, pixelRatio: 1 });
  const [overrides, setOverrides] = useState<Partial<WidgetSettings>>(initial ?? {});
  // New settings from the host (the layout reset, or edited elsewhere) replace the widget's.
  const initialKey = JSON.stringify(initial ?? {});
  const [synced, setSynced] = useState(initialKey);
  if (initialKey !== synced) {
    setSynced(initialKey);
    setOverrides(initial ?? {});
  }
  const kind = useReplay((s) => (s.session && s.race ? sessionKind(s.session) : null));

  // Measured before paint, and the widget mounts only once it's measured: its first render knows its size.
  // Browser zoom (and moving to another screen) changes the pixel ratio and fires a resize.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = (box: { width: number; height: number } = el.getBoundingClientRect()) => {
      const width = Math.floor(box.width);
      const height = Math.floor(box.height);
      const pixelRatio = window.devicePixelRatio || 1;
      setSize((m) => (m.width === width && m.height === height && m.pixelRatio === pixelRatio ? m : { width, height, pixelRatio }));
    };
    measure();
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect));
    ro.observe(el);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => visibility.set(entry.isIntersecting));
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [visibility]);

  const latest = useRef({ overrides, onSettingsChange });
  latest.current = { overrides, onSettingsChange };
  const update = useCallback((patch: Partial<WidgetSettings>) => {
    const next = { ...latest.current.overrides, ...patch };
    setOverrides(next);
    latest.current.onSettingsChange?.(next);
  }, []);
  const settingsValue = useMemo<SettingsValue>(
    () => ({ settings: { ...widget.settings, ...overrides } as WidgetSettings, update }),
    [widget.settings, overrides, update],
  );

  // Memoised: the widget re-renders only through its own hooks (and contexts), never because the host did.
  const Widget = widget.Component;
  const content = useMemo(() => <Widget />, [Widget]);
  const resetKey = `${widget.id}:${JSON.stringify(settingsValue.settings)}`;
  return (
    <div ref={ref} className={className} style={style}>
      {kind && widget.sessions.includes(kind) && size.width > 0 && (
        <VisibilityContext.Provider value={visibility}>
          <SettingsContext.Provider value={settingsValue}>
            <SizeContext.Provider value={size}>
              <Boundary name={widget.name} resetKey={resetKey}>
                {content}
              </Boundary>
            </SizeContext.Provider>
          </SettingsContext.Provider>
        </VisibilityContext.Provider>
      )}
    </div>
  );
}
