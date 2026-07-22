"use client";

/**
 * File: src/node-tree-overview.tsx
 * Area: Alt-Tab-style overview
 * Purpose: Hold Tab to see every body as a flat hierarchical tree, pick one, and
 *          fly the 3D camera there on release (via the same focus-event bridge
 *          UniverseCanvas already listens on).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { focusKeyFor, type Body } from "./universe-canvas";
import { FOCUS_EVENT } from "./dashboard-layout";

export type NodeTreeOverviewProps = {
  bodies: Body[];
};

type TreeRow = {
  body: Body;
  depth: number;
  focusKey: string;
};

function flattenTree(bodies: Body[]): TreeRow[] {
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const byParent = new Map<string, Body[]>();
  bodies.forEach((body) => {
    if (body.parentId && byId.has(body.parentId)) {
      const list = byParent.get(body.parentId) ?? [];
      list.push(body);
      byParent.set(body.parentId, list);
    }
  });

  const roots = bodies.filter((body) => !body.parentId || !byId.has(body.parentId));
  const rows: TreeRow[] = [];

  const visit = (body: Body, depth: number) => {
    rows.push({ body, depth, focusKey: focusKeyFor(body.id, bodies) });
    (byParent.get(body.id) ?? []).forEach((child) => visit(child, depth + 1));
  };

  roots.forEach((root) => visit(root, 0));
  return rows;
}

export function NodeTreeOverview({ bodies }: NodeTreeOverviewProps) {
  const [visible, setVisible] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const rows = useMemo(() => flattenTree(bodies), [bodies]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const confirmAndClose = () => {
      const row = rowsRef.current[highlightIndex];
      if (row) {
        window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { focusKey: row.focusKey } }));
      }
      setVisible(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        // Only claim Tab when nothing else is focused (i.e. no dialog/form is
        // open) -- otherwise this steals normal field-to-field tabbing from
        // any open form.
        if (!visible && document.activeElement && document.activeElement !== document.body) {
          return;
        }
        event.preventDefault();
        if (!visible) {
          setHighlightIndex(0);
          setVisible(true);
        }
        return;
      }

      if (!visible) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((index) => Math.min(index + 1, rowsRef.current.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Escape") {
        setVisible(false);
      } else if (event.key === "Enter") {
        confirmAndClose();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Tab" && visible) {
        confirmAndClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [visible, highlightIndex]);

  if (!visible) {
    return null;
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/90 p-3 shadow-2xl">
        <p className="px-2 pb-2 text-xs tracking-[0.2em] text-slate-400">
          HOLD TAB · ↑↓ TO BROWSE · RELEASE OR ENTER TO FLY
        </p>
        <ul className="grid gap-0.5">
          {rows.map((row, index) => (
            <li key={row.body.id}>
              <button
                type="button"
                onMouseEnter={() => setHighlightIndex(index)}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { focusKey: row.focusKey } }));
                  setVisible(false);
                }}
                style={{ paddingLeft: `${0.75 + row.depth * 1.1}rem` }}
                className={[
                  "flex w-full items-center gap-2 rounded-lg py-1.5 pr-3 text-left text-sm transition",
                  index === highlightIndex
                    ? "bg-cyan-200/10 text-cyan-100"
                    : "text-slate-200 hover:bg-slate-800/60",
                ].join(" ")}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.body.color }} aria-hidden />
                <span className="truncate">{row.body.label}</span>
                <span className="ml-auto shrink-0 text-[11px] tracking-[0.1em] text-slate-500">{row.body.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
