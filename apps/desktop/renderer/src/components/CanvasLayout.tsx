import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import type { CanvasBlock, CanvasDocument } from "@eve/contracts";
import { canvasLayoutPositions } from "./canvasLayoutPositions";

/** A flat, keyed tree keeps real editing buffers alive when the composition changes. */
export function CanvasLayout({
  document,
  children,
}: {
  document: CanvasDocument;
  children(block: CanvasBlock): ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const mountOrder = useRef(new Map<string, number>());
  for (const block of document.blocks) {
    if (!mountOrder.current.has(block.id))
      mountOrder.current.set(block.id, mountOrder.current.size);
  }
  const [size, setSize] = useState({
    width: 0,
    heights: {} as Record<string, number>,
  });
  const identities = document.blocks.map((block) => block.id).join("\u0000");
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const heights: Record<string, number> = {};
      for (const child of Array.from(element.children) as HTMLElement[]) {
        heights[child.dataset.blockId!] = Math.ceil(
          child.getBoundingClientRect().height,
        );
      }
      setSize((previous) =>
        previous.width === width &&
        Object.keys(heights).length === Object.keys(previous.heights).length &&
        Object.entries(heights).every(
          ([id, height]) => previous.heights[id] === height,
        )
          ? previous
          : { width, heights },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [identities]);

  const layout = size.width > 0 && size.width < 740 ? "focus" : document.layout;
  const positions = canvasLayoutPositions(
    document.blocks,
    layout,
    size.heights,
  );
  // Explicit ranks also invalidate Chromium's focus order when only grid rows change.
  const readingOrder = new Map(
    [...positions.entries()]
      .sort((a, b) => a[1].start - b[1].start || a[1].column - b[1].column)
      .map(([id], index) => [id, index]),
  );
  // React moving an existing textarea can clear Chromium's native undo history.
  // Reordering therefore changes geometry only; already-mounted nodes stay in place.
  const mounted = [...document.blocks].sort(
    (a, b) => mountOrder.current.get(a.id)! - mountOrder.current.get(b.id)!,
  );
  return (
    <div ref={root} className="canvas-layout" data-layout={layout}>
      {mounted.map((block) => {
        const position = positions.get(block.id)!;
        return (
          <div
            key={block.id}
            className="canvas-layout-slot"
            data-block-id={block.id}
            data-supporting={position.supporting}
            style={
              {
                ...position.style,
                "--canvas-reading-order": readingOrder.get(block.id),
              } as CSSProperties
            }
          >
            {children(block)}
          </div>
        );
      })}
    </div>
  );
}
