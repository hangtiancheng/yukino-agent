import type { ReactComponentImplementation } from "@a2ui/react/v0_9";

import { Chart } from "./chart";
import {
  Attachment,
  Bubble,
  Marker,
  Message,
  MessageScroller,
  Questionnaire,
} from "./chat";
import {
  Alert,
  AspectRatio,
  Avatar,
  Badge,
  Empty,
  Item,
  Kbd,
  Label,
  Progress,
  ScrollArea,
  Skeleton,
  Spinner,
} from "./display";
import {
  Calendar,
  Combobox,
  Command,
  Field,
  InputGroup,
  InputOtp,
  NativeSelect,
  Select,
  Switch,
  Toggle,
} from "./forms";
import { Breadcrumb, Menubar, NavigationMenu, Pagination } from "./navigation";
import {
  AlertDialog,
  ContextMenu,
  Drawer,
  DropdownMenu,
  HoverCard,
  Popover,
  Sheet,
  Tooltip,
} from "./overlays";
import {
  Accordion,
  ButtonGroup,
  Carousel,
  Collapsible,
  Resizable,
  Table,
} from "./structure";

// Extension components beyond the official basic-catalog contract: every
// shadcn/ui family from src/components/ui that is surface-embeddable.
// Not exposed separately because they are already covered by basic entries:
// button, card, tabs, slider, checkbox, radio-group, toggle-group, separator,
// input, textarea, dialog. Not exposed because they are not declarative
// surface components: sidebar (app chrome), toast (imperative), direction
// (context provider re-export).
export const shadcnExtensionComponents: ReactComponentImplementation[] = [
  // display
  Alert,
  AspectRatio,
  Avatar,
  Badge,
  Empty,
  Item,
  Kbd,
  Label,
  Progress,
  ScrollArea,
  Skeleton,
  Spinner,
  // structure
  Accordion,
  ButtonGroup,
  Carousel,
  Collapsible,
  Resizable,
  Table,
  // overlays
  AlertDialog,
  ContextMenu,
  Drawer,
  DropdownMenu,
  HoverCard,
  Popover,
  Sheet,
  Tooltip,
  // navigation
  Breadcrumb,
  Menubar,
  NavigationMenu,
  Pagination,
  // forms
  Calendar,
  Combobox,
  Command,
  Field,
  InputGroup,
  InputOtp,
  NativeSelect,
  Select,
  Switch,
  Toggle,
  // chat
  Attachment,
  Bubble,
  Marker,
  Message,
  MessageScroller,
  Questionnaire,
  // data
  Chart,
];
