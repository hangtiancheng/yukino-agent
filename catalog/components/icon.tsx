import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BellOff,
  Calendar,
  CalendarDays,
  Camera,
  Check,
  CircleAlert,
  CircleHelp,
  CircleUserRound,
  CreditCard,
  Download,
  Ellipsis,
  EllipsisVertical,
  Eye,
  EyeOff,
  FastForward,
  Folder,
  Heart,
  HeartOff,
  House,
  Image,
  Info,
  Lock,
  LockOpen,
  type LucideIcon,
  Mail,
  MapPin,
  Menu,
  Pause,
  Pencil,
  Phone,
  Paperclip,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Rewind,
  Search,
  Send,
  Settings,
  Share2,
  ShoppingCart,
  SkipBack,
  SkipForward,
  Smartphone,
  Square,
  Star,
  StarHalf,
  StarOff,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { IconApi } from "@a2ui/web_core/v0_9/basic_catalog";

export const ICON_MAP: Record<string, LucideIcon> = {
  accountCircle: CircleUserRound,
  add: Plus,
  arrowBack: ArrowLeft,
  arrowForward: ArrowRight,
  attachFile: Paperclip,
  calendarToday: Calendar,
  call: Phone,
  camera: Camera,
  check: Check,
  close: X,
  delete: Trash2,
  download: Download,
  edit: Pencil,
  event: CalendarDays,
  error: CircleAlert,
  fastForward: FastForward,
  favorite: Heart,
  favoriteOff: HeartOff,
  folder: Folder,
  help: CircleHelp,
  home: House,
  info: Info,
  locationOn: MapPin,
  lock: Lock,
  lockOpen: LockOpen,
  mail: Mail,
  menu: Menu,
  moreVert: EllipsisVertical,
  moreHoriz: Ellipsis,
  notificationsOff: BellOff,
  notifications: Bell,
  pause: Pause,
  payment: CreditCard,
  person: User,
  phone: Smartphone,
  photo: Image,
  play: Play,
  print: Printer,
  refresh: RefreshCw,
  rewind: Rewind,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shoppingCart: ShoppingCart,
  skipNext: SkipForward,
  skipPrevious: SkipBack,
  star: Star,
  starHalf: StarHalf,
  starOff: StarOff,
  stop: Square,
  upload: Upload,
  visibility: Eye,
  visibilityOff: EyeOff,
  volumeDown: Volume1,
  volumeMute: Volume,
  volumeOff: VolumeX,
  volumeUp: Volume2,
  warning: TriangleAlert,
};

export const Icon = createComponentImplementation(IconApi, ({ props }) => {
  const name = props.name;

  // The svgPath variant carries path data inside the protocol message itself.
  if (typeof name === "object" && name !== null && "svgPath" in name) {
    return (
      <svg viewBox="0 0 24 24" className="size-6 shrink-0 fill-current">
        <path d={(name as { svgPath: string }).svgPath} />
      </svg>
    );
  }

  const LucideGlyph =
    (typeof name === "string" && ICON_MAP[name]) || CircleHelp;
  return <LucideGlyph className="size-6 shrink-0" />;
});

export function CatalogIcon({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  if (!name) return null;
  const LucideGlyph = ICON_MAP[name];
  if (!LucideGlyph) return null;
  return <LucideGlyph className={className} />;
}
