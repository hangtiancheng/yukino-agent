import type { ReactComponentImplementation } from "@a2ui/react/v0_9";
import { Catalog } from "@a2ui/web_core/v0_9";
import { BASIC_FUNCTIONS } from "@a2ui/web_core/v0_9/basic_catalog";

import { AudioPlayer } from "./components/audio-player";
import { Button } from "./components/button";
import { Card } from "./components/card";
import { CheckBox } from "./components/check-box";
import { ChoicePicker } from "./components/choice-picker";
import { Column } from "./components/column";
import { DateTimeInput } from "./components/date-time-input";
import { Divider } from "./components/divider";
import { Icon } from "./components/icon";
import { Image } from "./components/image";
import { List } from "./components/list";
import { Modal } from "./components/modal";
import { Row } from "./components/row";
import { Slider } from "./components/slider";
import { Tabs } from "./components/tabs";
import { Text } from "./components/text";
import { TextField } from "./components/text-field";
import { Video } from "./components/video";
import { shadcnExtensionComponents } from "./shadcn";

export const SHADCN_CATALOG_ID =
  "https://raw.githubusercontent.com/hangtiancheng/a2ui/main/packages/shadcn/catalog.json";

const components: ReactComponentImplementation[] = [
  Text,
  Image,
  Icon,
  Video,
  AudioPlayer,
  Row,
  Column,
  List,
  Card,
  Tabs,
  Divider,
  Modal,
  Button,
  TextField,
  CheckBox,
  ChoicePicker,
  Slider,
  DateTimeInput,
  ...shadcnExtensionComponents,
];

// Manually maintained shadcn/ui implementation of the official basic catalog
// (same catalogId and contract), extended with catalog entries for every
// remaining shadcn/ui component family from src/components/ui.
export const shadcnCatalog = new Catalog<ReactComponentImplementation>(
  SHADCN_CATALOG_ID,
  components,
  BASIC_FUNCTIONS,
);
