// The core's shell around one block: its settings, size and visibility, and a boundary so a block
// that throws doesn't take the screen down with it. The block renders only with a session it supports.

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReplay } from "../store";
import { createVisibility, ScaleContext, SettingsContext, SizeContext, VisibilityContext, type BlockSize, type SettingsValue } from "./context";
import type { BlockDefinition, BlockSettings } from "./defineBlock";
import { sessionKind } from "./select";

export interface BlockHostProps {
  // Any block's settings type: the host only merges and stores them.
  block: BlockDefinition<any>;
  /** The user's settings for this block (from the layout), on top of the definition's defaults. */
  settings?: Partial<BlockSettings>;
  /** Called with the user's settings (not the defaults) whenever the block changes them, for the layout to store. */
  onSettingsChange?: (settings: Partial<BlockSettings>) => void;
  /**
   * Layout px to screen px: the block is laid out at its size / scale and zoomed to fill it, so its
   * contents scale with its width (H3.8). The grid sets it; 1 by default.
   */
  scale?: number;
  className?: string;
  style?: CSSProperties;
}

/** Catches a crashed block; it gets another go when `resetKey` changes (another block or other settings). */
class Boundary extends Component<{ name: string; resetKey: string; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error(`Block "${this.props.name}" crashed`, error);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.error != null && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error == null) return this.props.children;
    return <div className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-500">{this.props.name} stopped working</div>;
  }
}

/** Screen size of the host in CSS px, and the display's device pixel ratio. */
interface Measured {
  width: number;
  height: number;
  dpr: number;
}

export function BlockHost({ block, settings: initial, onSettingsChange, scale = 1, className, style }: BlockHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibility] = useState(createVisibility);
  const [measured, setMeasured] = useState<Measured>({ width: 0, height: 0, dpr: 1 });
  const [overrides, setOverrides] = useState<Partial<BlockSettings>>(initial ?? {});
  // New settings from the host (the layout reset, or edited elsewhere) replace the block's.
  const initialKey = JSON.stringify(initial ?? {});
  const [synced, setSynced] = useState(initialKey);
  if (initialKey !== synced) {
    setSynced(initialKey);
    setOverrides(initial ?? {});
  }
  const kind = useReplay((s) => (s.session && s.race ? sessionKind(s.session) : null));

  // Measured before paint, and the block mounts only once it's measured: its first render knows its size.
  // Browser zoom (and moving to another screen) changes the pixel ratio and fires a resize.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = (width = el.clientWidth, height = el.clientHeight) => {
      const dpr = window.devicePixelRatio || 1;
      setMeasured((m) => (m.width === width && m.height === height && m.dpr === dpr ? m : { width, height, dpr }));
    };
    measure();
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height));
    ro.observe(el);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // Layout px: what the block sees. In the grid, the same at every screen size.
  const size = useMemo<BlockSize>(
    () => ({ width: Math.round(measured.width / scale), height: Math.round(measured.height / scale), pixelRatio: measured.dpr * scale }),
    [measured, scale],
  );

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => visibility.set(entry.isIntersecting));
    io.observe(ref.current!);
    return () => io.disconnect();
  }, [visibility]);

  const latest = useRef({ overrides, onSettingsChange });
  latest.current = { overrides, onSettingsChange };
  const update = useCallback((patch: Partial<BlockSettings>) => {
    const next = { ...latest.current.overrides, ...patch };
    setOverrides(next);
    latest.current.onSettingsChange?.(next);
  }, []);
  const settingsValue = useMemo<SettingsValue>(
    () => ({ settings: { ...block.settings, ...overrides } as BlockSettings, update }),
    [block.settings, overrides, update],
  );

  // Memoised: the block re-renders only through its own hooks (and contexts), never because the host did.
  const Block = block.Component;
  const content = useMemo(() => <Block />, [Block]);
  const resetKey = `${block.id}:${JSON.stringify(settingsValue.settings)}`;
  return (
    <div ref={ref} className={className} style={style}>
      {kind && block.sessions.includes(kind) && size.width > 0 && (
        <div style={{ width: size.width, height: size.height, zoom: scale === 1 ? undefined : scale }}>
          <VisibilityContext.Provider value={visibility}>
            <SettingsContext.Provider value={settingsValue}>
              <SizeContext.Provider value={size}>
                <ScaleContext.Provider value={scale}>
                  <Boundary name={block.name} resetKey={resetKey}>
                    {content}
                  </Boundary>
                </ScaleContext.Provider>
              </SizeContext.Provider>
            </SettingsContext.Provider>
          </VisibilityContext.Provider>
        </div>
      )}
    </div>
  );
}
