"use client";
import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion } from "motion/react";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AIOpsButtonProps {
  onClick: () => void;
  disabled: boolean;
}

// Pointer movement below this many pixels counts as a click, not a drag.
const DRAG_THRESHOLD = 4;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  dragged: boolean;
}

export default function AIOpsBtn({ onClick, disabled }: AIOpsButtonProps) {
  // null = never dragged: keep the default centered spot in the chat header.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      dragged: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (
      !drag.dragged &&
      Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
      Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
    ) {
      return;
    }
    drag.dragged = true;
    setPos({
      x: Math.min(
        Math.max(e.clientX - drag.offsetX, 0),
        window.innerWidth - drag.width,
      ),
      y: Math.min(
        Math.max(e.clientY - drag.offsetY, 0),
        window.innerHeight - drag.height,
      ),
    });
  };

  const handlePointerEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // The click event fires after pointerup; swallow it if this was a drag.
    suppressClickRef.current = drag.dragged;
    dragRef.current = null;
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (disabled) return;
    onClick();
  };

  return (
    // The wrapper owns position so motion transforms (hover/tap scale) never
    // fight the Tailwind centering translate.
    <div
      className={cn(
        "z-10 select-none",
        pos ? "fixed" : "absolute top-4 left-1/2 -translate-x-1/2",
      )}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <Button
        size="lg"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        // aria-disabled instead of disabled: a natively disabled button swallows
        // pointer events, which would make it undraggable while streaming.
        aria-disabled={disabled}
        render={
          <motion.button
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            transition={{
              y: { type: "spring", visualDuration: 0.4, bounce: 0.3 },
              opacity: { duration: 0.25, ease: "easeOut" },
            }}
            className="cursor-grab touch-none active:cursor-grabbing"
          />
        }
        className={cn("rounded-full px-4 shadow-lg", disabled && "opacity-50")}
      >
        <Layers data-icon="inline-start" />
        <span>AI Ops</span>
      </Button>
    </div>
  );
}
