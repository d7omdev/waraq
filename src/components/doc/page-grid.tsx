"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Loader2 } from "lucide-react";
import { cx } from "@/lib/client/format";
import { vibrate } from "@/lib/client/device";
import type { PageInfo } from "@/lib/types";
import { Thumb } from "@/components/ui/media";

/**
 * Sortable page grid. `order` is the list of current page indexes in display
 * order; reorders are reported as a full permutation of original indexes.
 */
export function PageGrid({
  pages,
  order,
  selecting,
  selected,
  onToggle,
  onOpen,
  onReorder,
  disabled,
  pendingFrom,
}: {
  pages: PageInfo[];
  order: number[];
  selecting: boolean;
  selected: number[];
  onToggle: (index: number) => void;
  onOpen: (position: number) => void;
  onReorder: (order: number[]) => void;
  disabled?: boolean;
  /** while the document is processing: pages at or after this index are not built yet */
  pendingFrom?: number | null;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  const ids = order.map((i) => i + 1); // dnd-kit ids must be truthy

  const onStart = (e: DragStartEvent) => {
    setActiveId(Number(e.active.id) - 1);
    vibrate(15, "select");
  };
  const onEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    vibrate(8, "select");
    onReorder(arrayMove(order, from, to));
  };

  const byIndex = new Map(pages.map((p) => [p.index, p]));
  const activePage = activeId !== null ? byIndex.get(activeId) : undefined;

  // per-page status when the server reports it, else "pages after the built count"
  const isPending = (p: PageInfo, pageIndex: number) =>
    p.status ? p.status === "processing" : pendingFrom != null && pageIndex >= pendingFrom;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy} disabled={disabled}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {order.map((pageIndex, pos) => {
            const p = byIndex.get(pageIndex);
            if (!p) return null;
            return (
              <SortablePage
                key={pageIndex + 1}
                id={pageIndex + 1}
                page={p}
                position={pos}
                selecting={selecting}
                selected={selected.includes(pageIndex)}
                pending={isPending(p, pageIndex)}
                onClick={() => (selecting ? onToggle(pageIndex) : isPending(p, pageIndex) ? undefined : onOpen(pos))}
              />
            );
          })}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.22,1,0.36,1)" }}>
        {activePage ? (
          <div className="rotate-2 scale-105">
            <Thumb
              src={activePage.thumbUrl}
              className="aspect-[3/4] rounded-2xl bg-s2 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.9)] ring-2 ring-accent"
              fit="contain"
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortablePage({
  id,
  page,
  position,
  selecting,
  selected,
  onClick,
  pending,
}: {
  id: number;
  page: PageInfo;
  position: number;
  selecting: boolean;
  selected: boolean;
  onClick: () => void;
  pending?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx("relative", isDragging && "opacity-30")}
    >
      <button
        type="button"
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
        {...attributes}
        {...listeners}
        aria-label={`Page ${position + 1}${selected ? ", selected" : ""}`}
        data-page-tile
        className={cx(
          "focus-ring group relative block w-full touch-manipulation rounded-2xl [-webkit-touch-callout:none]",
        )}
      >
        <div
          className={cx(
            "surface relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-2xl transition-[transform,border-color] duration-200",
            selected ? "scale-[0.96] border-accent ring-2 ring-accent/60" : "group-hover:border-line-strong group-active:scale-[0.98]",
          )}
        >
          {pending ? (
            <div className="absolute inset-x-3 top-3 bottom-8 flex flex-col items-center justify-center gap-2 rounded-md bg-paper/[0.06]" data-page-pending>
              <div className="skeleton absolute inset-0 rounded-md opacity-60" />
              <Loader2 className="relative size-5 animate-spin text-accent" />
              <span className="relative text-[12px] text-muted">Processing</span>
            </div>
          ) : (
            <Thumb
              src={page.thumbUrl}
              fit="contain"
              className="absolute inset-x-3 top-3 bottom-8 bg-transparent"
              imgClassName="drop-shadow-[0_6px_10px_rgb(0_0_0/0.55)]"
            />
          )}
        </div>
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2 text-[12px] leading-5 font-medium text-white/90 tabular-nums">
          {position + 1}
        </span>
        {selecting ? (
          <span
            className={cx(
              "absolute top-2 left-2 flex size-6 items-center justify-center rounded-full border-[1.5px] shadow-[0_1px_4px_rgb(0_0_0/0.5)]",
              selected ? "border-accent-strong bg-accent-strong text-white" : "border-white/85 bg-black/40 text-transparent",
            )}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        ) : (
          <span className="absolute top-2 right-2 hidden size-7 items-center justify-center rounded-md bg-black/60 text-white/80 group-hover:flex">
            <GripVertical className="size-4" />
          </span>
        )}
      </button>
    </div>
  );
}
