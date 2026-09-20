import { useEffect, useRef } from "react";

export const curveLabel = (values: number[]) =>
  `cubic-bezier(${values.map((value) => Number(value.toFixed(2))).join(", ")})`;
export function Curve({
  value,
  interactive = false,
  onChange,
}: {
  value: number[];
  interactive?: boolean;
  onChange?: (value: [number, number, number, number]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const endDrag = useRef<(() => void) | null>(null);
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => () => endDrag.current?.(), []);
  const change = (index: number, coordinate: number) => {
    if (!Number.isFinite(coordinate)) return;
    const next = [...currentValue.current] as [number, number, number, number];
    next[index] = Math.max(
      index % 2 ? -2 : 0,
      Math.min(index % 2 ? 3 : 1, coordinate),
    );
    onChange?.(next);
  };
  const drag = (index: 0 | 2, event: React.PointerEvent) => {
    if (!interactive) return;
    endDrag.current?.();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const move = (event: PointerEvent) => {
      const matrix = svg.current?.getScreenCTM();
      if (!svg.current || !matrix) return;
      const point = svg.current.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const p = point.matrixTransform(matrix.inverse());
      const next = [...currentValue.current] as [
        number,
        number,
        number,
        number,
      ];
      next[index] = Math.max(0, Math.min(1, (p.x - 22) / 240));
      const bottom = Math.min(
        0,
        currentValue.current[1],
        currentValue.current[3],
      );
      const top = Math.max(1, currentValue.current[1], currentValue.current[3]);
      next[index + 1] = Math.max(
        -2,
        Math.min(3, top - ((p.y - 16) / 160) * (top - bottom)),
      );
      onChange?.(next);
    };
    const cleanup = () => {
      element.removeEventListener("pointermove", move as EventListener);
      element.removeEventListener("pointerup", cleanup);
      element.removeEventListener("pointercancel", cleanup);
      endDrag.current = null;
    };
    endDrag.current = cleanup;
    element.addEventListener("pointermove", move as EventListener);
    element.addEventListener("pointerup", cleanup);
    element.addEventListener("pointercancel", cleanup);
  };
  const bottom = Math.min(0, value[1], value[3]);
  const top = Math.max(1, value[1], value[3]);
  const y = (value: number) => 16 + ((top - value) / (top - bottom)) * 160;
  const p1 = [22 + value[0] * 240, y(value[1])];
  const p2 = [22 + value[2] * 240, y(value[3])];
  return (
    <>
      <svg
        ref={svg}
        viewBox="0 0 284 198"
        className={`curve ${interactive ? "interactive" : ""}`}
        aria-label={`Easing curve ${value.join(", ")}`}
        role="img"
      >
        {[16, 56, 96, 136, 176].map((y) => (
          <line
            key={`y${y}`}
            x1="22"
            x2="262"
            y1={y}
            y2={y}
            className="curve-grid"
          />
        ))}
        {[22, 82, 142, 202, 262].map((x) => (
          <line
            key={`x${x}`}
            x1={x}
            x2={x}
            y1="16"
            y2="176"
            className="curve-grid"
          />
        ))}
        <line x1="22" y1={y(0)} x2="262" y2={y(1)} className="curve-baseline" />
        {interactive && (
          <>
            <line
              x1="22"
              y1={y(0)}
              x2={p1[0]}
              y2={p1[1]}
              className="curve-handle-line"
            />
            <line
              x1="262"
              y1={y(1)}
              x2={p2[0]}
              y2={p2[1]}
              className="curve-handle-line"
            />
          </>
        )}
        <path
          d={`M22 ${y(0)} C ${p1.join(" ")} ${p2.join(" ")} 262 ${y(1)}`}
          className="curve-path"
        />
        {interactive && (
          <>
            <circle
              cx={p1[0]}
              cy={p1[1]}
              r="8"
              className="curve-handle"
              onPointerDown={(event) => drag(0, event)}
            />
            <circle
              cx={p2[0]}
              cy={p2[1]}
              r="8"
              className="curve-handle"
              onPointerDown={(event) => drag(2, event)}
            />
          </>
        )}
        <circle cx="22" cy={y(0)} r="3" fill="currentColor" />
        <circle cx="262" cy={y(1)} r="3" fill="currentColor" />
      </svg>
      {interactive && (
        <details className="curve-coordinates">
          <summary>Adjust control points</summary>
          <div>
            {[
              "First point: time",
              "First point: progress",
              "Second point: time",
              "Second point: progress",
            ].map((label, index) => (
              <label key={label}>
                {label}
                <input
                  type="number"
                  min={index % 2 ? -2 : 0}
                  max={index % 2 ? 3 : 1}
                  step="0.01"
                  value={Number(value[index].toFixed(2))}
                  onChange={(event) =>
                    change(index, event.currentTarget.valueAsNumber)
                  }
                />
              </label>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
