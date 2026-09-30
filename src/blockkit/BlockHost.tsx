// The core's shell around one block: its settings, size and visibility, and a boundary so a block
// that throws doesn't take the screen down with it. The block renders only with a session it supports.

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReplay } from "../store";
import { createVisibility, SettingsContext, SizeContext, VisibilityContext, type BlockSize, type SettingsValue } from "./context";
import type { BlockDefinition, BlockSettings } from "./defineBlock";
import { sessionKind } from "./select";

export interface BlockHostProps {
  // Any block's settings type: the host only merges and stores them.
  block: BlockDefinition<any>;
  /** The user's settings for this block (from the layout), on top of the definition's defaults. */
  settings?: Partial<BlockSettings>;
  /** Called with the user's settings (not the defaults) whenever the block changes them, for the layout to store. */
  onSettingsChange?: (settings: Partial<BlockSettings>) => void;
  className?: string;
  style?: CSSProperties;
}

class Boundary extends Component<{ name: string; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error(`Block "${this.props.name}" crashed`, error);
  }
  render() {
    if (this.state.error == null) return this.props.children;
    return <div className="flex h-full items-center justify-center p-3 text-center text-xs text-zinc-500">{this.props.name} stopped working</div>;
  }
}

export function BlockHost({ block, settings: initial, onSettingsChange, className, style }: BlockHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibility] = useState(createVisibility);
  const [size, setSize] = useState<BlockSize>({ width: 0, height: 0 });
  const [overrides, setOverrides] = useState<Partial<BlockSettings>>(initial ?? {});
  const kind = useReplay((s) => (s.session && s.race ? sessionKind(s.session) : null));

  // Measured before paint, so a canvas block's first render already knows its size.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = (width: number, height: number) =>
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    const rect = el.getBoundingClientRect();
    measure(Math.floor(rect.width), Math.floor(rect.height));
    const ro = new ResizeObserver(([entry]) => measure(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const Block = block.Component;
  return (
    <div ref={ref} className={className} style={style}>
      {kind && block.sessions.includes(kind) && (
        <VisibilityContext.Provider value={visibility}>
          <SettingsContext.Provider value={settingsValue}>
            <SizeContext.Provider value={size}>
              <Boundary key={block.id} name={block.name}>
                <Block />
              </Boundary>
            </SizeContext.Provider>
          </SettingsContext.Provider>
        </VisibilityContext.Provider>
      )}
    </div>
  );
}
