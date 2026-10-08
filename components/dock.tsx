"use client";

// macOS-style bottom Dock for switching between the app surfaces:
// OnCall Agent (/), DevFlow (/devflow) and the A2UI Gallery (/gallery).
// - Icons magnify as the pointer sweeps across the dock (spring-smoothed,
//   driven by a single shared mouseX MotionValue).
// - Hovering an icon reveals a tooltip label above it.
// - The active route is marked with a small dot under its icon.
// Mounted once in the root layout; it floats above page content (pages keep
// their full height, nothing is pushed aside).

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations, type Messages } from "next-intl";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  BookOpen,
  BotMessageSquare,
  FlaskConical,
  FolderGit2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE_SIZE = 40;
const MAX_SIZE = 60;
// Horizontal distance (px) from an icon centre at which magnification ends.
const MAGNET_RANGE = 100;

interface DockItemDef {
  href: string;
  labelKey: keyof Messages["dock"];
  icon: typeof BotMessageSquare;
  isActive: (pathname: string) => boolean;
}

// Tiles share the theme's sage-green primary colour (light/dark aware).
const DOCK_ITEMS: DockItemDef[] = [
  {
    href: "/",
    labelKey: "oncall",
    icon: BotMessageSquare,
    isActive: (p) => p === "/",
  },
  {
    href: "/devflow",
    labelKey: "devflow",
    icon: FolderGit2,
    isActive: (p) => p.startsWith("/devflow"),
  },
  {
    href: "/knowledge",
    labelKey: "knowledge",
    icon: BookOpen,
    isActive: (p) => p.startsWith("/knowledge"),
  },
  {
    href: "/gallery",
    labelKey: "gallery",
    icon: FlaskConical,
    isActive: (p) => p.startsWith("/gallery"),
  },
];

function DockItem({
  item,
  active,
  mouseX,
}: {
  item: DockItemDef;
  active: boolean;
  mouseX: MotionValue<number>;
}) {
  const t = useTranslations("dock");
  const tileRef = useRef<HTMLDivElement>(null);

  // Distance between the pointer and this icon's centre; Infinity when the
  // pointer is outside the dock (useTransform clamps it back to BASE_SIZE).
  const distance = useTransform(mouseX, (x) => {
    const bounds = tileRef.current?.getBoundingClientRect();
    if (!bounds) return Infinity;
    return x - (bounds.x + bounds.width / 2);
  });
  const size = useSpring(
    useTransform(
      distance,
      [-MAGNET_RANGE, 0, MAGNET_RANGE],
      [BASE_SIZE, MAX_SIZE, BASE_SIZE],
    ),
    { mass: 0.1, stiffness: 180, damping: 14 },
  );

  return (
    <Link
      href={item.href}
      aria-label={t(item.labelKey)}
      aria-current={active ? "page" : undefined}
      className="group relative flex flex-col items-center outline-none"
    >
      <span
        className={cn(
          "pointer-events-none absolute -top-9 z-10 rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-md",
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
          "bg-popover text-popover-foreground",
        )}
      >
        {t(item.labelKey)}
      </span>
      <motion.div
        ref={tileRef}
        style={{ width: size, height: size }}
        className={cn(
          "bg-primary text-primary-foreground flex items-center justify-center rounded-[26%] shadow-lg ring-1 ring-black/10",
        )}
      >
        <item.icon style={{ width: "56%", height: "56%" }} strokeWidth={1.75} />
      </motion.div>
      {/* Active-route dot; always occupies space so tiles share a baseline. */}
      <span
        className={cn(
          "bg-foreground/80 mt-1.5 size-1 rounded-full transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      />
    </Link>
  );
}

export default function Dock() {
  const pathname = usePathname();
  const t = useTranslations("dock");
  const mouseX = useMotionValue(Infinity);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center">
      <nav
        aria-label={t("navigation")}
        onMouseMove={(e) => mouseX.set(e.clientX)}
        onMouseLeave={() => mouseX.set(Infinity)}
        className={cn(
          "pointer-events-auto flex items-end gap-2 rounded-2xl p-2 shadow-2xl backdrop-blur-xl",
          "bg-background/70 border border-white/40 dark:border-white/10",
        )}
      >
        {DOCK_ITEMS.map((item) => (
          <DockItem
            key={item.href}
            item={item}
            active={item.isActive(pathname)}
            mouseX={mouseX}
          />
        ))}
      </nav>
    </div>
  );
}
