// The core's shell around one widget: its settings, size and visibility, and a boundary so a widget
// that throws doesn't take the screen down with it. The widget renders only with a session it supports, or (a
// circuit widget on a circuit's page, which has no session) for the circuit it's given.

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReplay } from "../store";
import { CardStateContext, createVisibility, SettingsContext, SizeContext, VisibilityContext, type CardStateValue, type WidgetSize, type SettingsValue } from "./context";
import type { WidgetDefinition, WidgetSettings } from "./defineWidget";
import { sessionKind } from "./select";
import { CircuitContext, type CircuitScope } from "./circuit";

export interface WidgetHostProps {
  // Any widget's settings type: the host only merges and stores them.
  widget: WidgetDefinition<any>;
  /** The user's settings for this widget (from the layout), on top of the definition's defaults. */
  settings?: Partial<WidgetSettings>;
  /** Called with the user's settings (not the defaults) whenever the widget changes them, for the layout to store. */
  onSettingsChange?: (settings: Partial<WidgetSettings>) => void;
  className?: string;
  style?: CSSProperties;
  /** A circuit's page: the circuit a circuit widget shows, with no session needed. */
  circuit?: CircuitScope;
  /** Device px per CSS px for the widget's canvases, instead of the display's (a share card's, drawn bigger). */
  pixelRatio?: number;
  /** What the widget starts showing (its useCardState values, by key): a share card's copy, as the widget was. */
  cardState?: Readonly<Record<string, unknown>>;
}

/** What a mounted widget is, to mount it again elsewhere (a share card). */
export interface HostedWidget {
  widget: WidgetDefinition<any>;
  settings: Partial<WidgetSettings>;
  circuit?: CircuitScope;
}

const HOSTED = new WeakMap<Element, { current: HostedWidget }>();
const CARD_STATES = new WeakMap<Element, CardStateValue>();

/** The widget mounted in `el` (or `el` itself), as it's set now; null if there's none. */
export function hostedIn(el: Element): HostedWidget | null {
  const host = el.matches("[data-widget-host]") ? el : el.querySelector("[data-widget-host]");
  return (host && HOSTED.get(host)?.current) ?? null;
}

/** The useCardState values of the widget mounted in `el` (or `el` itself) as they are now, by key; empty if none. */
export function cardStateIn(el: Element): Record<string, unknown> {
  const host = el.matches("[data-widget-host]") ? el : el.querySelector("[data-widget-host]");
  const state = host && CARD_STATES.get(host);
  return state ? Object.fromEntries(state.live) : {};
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

export function WidgetHost({ widget, settings: initial, onSettingsChange, className, style, circuit, pixelRatio: ratio, cardState }: WidgetHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibility] = useState(createVisibility);
  // Read once: a copy starts as the widget was, then is its own.
  const [cardStateValue] = useState<CardStateValue>(() => ({ live: new Map(), seed: cardState ?? null }));
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
      const pixelRatio = ratio ?? (window.devicePixelRatio || 1);
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
  const hosted = useRef<HostedWidget>({ widget, settings: overrides, circuit });
  hosted.current = { widget, settings: overrides, circuit };
  useLayoutEffect(() => {
    HOSTED.set(ref.current!, hosted);
    CARD_STATES.set(ref.current!, cardStateValue);
  }, []);
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
    <div ref={ref} data-widget-host="" className={className} style={style}>
      {(circuit ? widget.group === "circuit" : kind && widget.sessions.includes(kind)) && size.width > 0 && (
        <CircuitContext.Provider value={circuit ?? null}>
          <CardStateContext.Provider value={cardStateValue}>
            <VisibilityContext.Provider value={visibility}>
              <SettingsContext.Provider value={settingsValue}>
                <SizeContext.Provider value={size}>
                  <Boundary name={widget.name} resetKey={resetKey}>
                    {content}
                  </Boundary>
                </SizeContext.Provider>
              </SettingsContext.Provider>
            </VisibilityContext.Provider>
          </CardStateContext.Provider>
        </CircuitContext.Provider>
      )}
    </div>
  );
}
