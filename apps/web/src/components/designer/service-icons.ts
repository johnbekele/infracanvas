/**
 * Icons for catalog services.
 *
 * One map, shared by the palette and the canvas node. They previously kept
 * separate copies, and the canvas one indexed it by `serviceId` rather than by
 * the icon name the catalog declares -- so every node on the canvas fell through
 * to the same default server glyph regardless of what it was.
 *
 * A glyph is chosen so that a reader who does not know the service name can
 * still tell what kind of thing it is, and so that two different services never
 * share one: a diagram where the load balancer, the API gateway and the GraphQL
 * API are all the same fork symbol tells the reader nothing.
 */
import type { ComponentType, SVGProps } from 'react';
import {
  Activity,
  AppWindow,
  Archive,
  ArrowRightLeft,
  AudioLines,
  BadgeCheck,
  BarChart3,
  Bell,
  Binary,
  Bot,
  Boxes,
  Braces,
  Brain,
  BrickWall,
  Building2,
  CalendarClock,
  Cloud,
  CloudCog,
  Columns3,
  Container,
  Cpu,
  Database,
  DatabaseZap,
  DoorOpen,
  FileJson,
  FileSearch,
  FileText,
  Filter,
  Fingerprint,
  Footprints,
  Globe,
  HardDrive,
  Hexagon,
  Image,
  Inbox,
  KeyRound,
  Languages,
  Layers,
  LayoutGrid,
  Leaf,
  Library,
  ListChecks,
  Lock,
  Mail,
  Map,
  MemoryStick,
  Mic,
  MonitorDot,
  Network,
  Package,
  Plug,
  Rabbit,
  Radio,
  RadioTower,
  Rocket,
  Route,
  Rows3,
  ScanText,
  Scale,
  Scaling,
  Search,
  Server,
  ServerCog,
  Share2,
  ShieldCheck,
  ShieldHalf,
  Ship,
  Sparkles,
  Split,
  Sprout,
  SquareStack,
  Table,
  Terminal,
  Users,
  Warehouse,
  Waves,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { AwsLambdaIcon } from './icons/AwsLambdaIcon';
import {
  AmazonAthenaIcon,
  AmazonCloudSearchDocumentsIcon,
  AmazonCloudSearchIcon,
  AmazonDataFirehoseIcon,
  AmazonEmrClusterIcon,
  AmazonEmrEngineIcon,
  AmazonEmrIcon,
  AmazonFinSpaceIcon,
  AmazonKinesisDataStreamsIcon,
  AmazonKinesisIcon,
  AmazonKinesisVideoStreamsIcon,
  AmazonManagedServiceForApacheFlinkIcon,
  AmazonMskIcon,
  AmazonOpenSearchServiceIcon,
  AmazonRedshiftIcon,
  AnalyticsCategoryIcon,
  AwsDataExchangeForApisIcon,
  AwsDataExchangeIcon,
  AwsGlueCrawlerIcon,
  AwsGlueDataBrewIcon,
  AwsGlueIcon,
  AwsLakeFormationIcon,
} from './icons/aws';

export type ServiceIconComponent = ComponentType<SVGProps<SVGSVGElement> | LucideProps>;

const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  'app-window': AppWindow,
  archive: Archive,
  'arrow-right-left': ArrowRightLeft,
  'audio-lines': AudioLines,
  'badge-check': BadgeCheck,
  'bar-chart-3': BarChart3,
  bell: Bell,
  binary: Binary,
  bot: Bot,
  boxes: Boxes,
  braces: Braces,
  brain: Brain,
  'brick-wall': BrickWall,
  'building-2': Building2,
  'calendar-clock': CalendarClock,
  cloud: Cloud,
  'cloud-cog': CloudCog,
  'columns-3': Columns3,
  container: Container,
  cpu: Cpu,
  database: Database,
  'database-zap': DatabaseZap,
  'door-open': DoorOpen,
  'file-json': FileJson,
  'file-search': FileSearch,
  'file-text': FileText,
  filter: Filter,
  fingerprint: Fingerprint,
  footprints: Footprints,
  globe: Globe,
  'hard-drive': HardDrive,
  hexagon: Hexagon,
  image: Image,
  inbox: Inbox,
  'key-round': KeyRound,
  languages: Languages,
  layers: Layers,
  'layout-grid': LayoutGrid,
  leaf: Leaf,
  library: Library,
  'list-checks': ListChecks,
  lock: Lock,
  mail: Mail,
  map: Map,
  'memory-stick': MemoryStick,
  mic: Mic,
  'monitor-dot': MonitorDot,
  network: Network,
  package: Package,
  plug: Plug,
  rabbit: Rabbit,
  radio: Radio,
  'radio-tower': RadioTower,
  rocket: Rocket,
  route: Route,
  'rows-3': Rows3,
  scale: Scale,
  scaling: Scaling,
  'scan-text': ScanText,
  search: Search,
  server: Server,
  'server-cog': ServerCog,
  'share-2': Share2,
  'shield-check': ShieldCheck,
  'shield-half': ShieldHalf,
  ship: Ship,
  sparkles: Sparkles,
  split: Split,
  sprout: Sprout,
  'square-stack': SquareStack,
  table: Table,
  terminal: Terminal,
  users: Users,
  warehouse: Warehouse,
  waves: Waves,
  webhook: Webhook,
  workflow: Workflow,
  zap: Zap,
};

/**
 * Icons that ship with their own brand colors (not inverted onto a color tile).
 *
 * The AWS marks come from the official icon package; see the README beside them
 * for provenance and how to take a newer one. Several are here without a catalog
 * entry pointing at them -- the category badge, the Kinesis family mark, and
 * services such as CloudSearch and Glue DataBrew that no Terraform resource can
 * provision -- because a mark being drawable is separate from a service being
 * exportable, and the palette should only offer what the exporter can emit.
 */
const BRANDED: Record<string, ServiceIconComponent> = {
  lambda: AwsLambdaIcon,
  'analytics-category': AnalyticsCategoryIcon,
  athena: AmazonAthenaIcon,
  cloudsearch: AmazonCloudSearchIcon,
  'cloudsearch-documents': AmazonCloudSearchDocumentsIcon,
  'data-exchange': AwsDataExchangeIcon,
  'data-exchange-apis': AwsDataExchangeForApisIcon,
  emr: AmazonEmrIcon,
  'emr-cluster': AmazonEmrClusterIcon,
  'emr-engine': AmazonEmrEngineIcon,
  finspace: AmazonFinSpaceIcon,
  firehose: AmazonDataFirehoseIcon,
  glue: AwsGlueIcon,
  'glue-crawler': AwsGlueCrawlerIcon,
  'glue-databrew': AwsGlueDataBrewIcon,
  kinesis: AmazonKinesisDataStreamsIcon,
  'kinesis-family': AmazonKinesisIcon,
  'kinesis-video-streams': AmazonKinesisVideoStreamsIcon,
  'lake-formation': AwsLakeFormationIcon,
  'managed-flink': AmazonManagedServiceForApacheFlinkIcon,
  msk: AmazonMskIcon,
  opensearch: AmazonOpenSearchServiceIcon,
  redshift: AmazonRedshiftIcon,
};

export function isBrandedIcon(iconName: string | undefined): boolean {
  return Boolean(iconName && BRANDED[iconName]);
}

/** The icon a service declares, falling back to a generic one. */
export function iconFor(iconName: string | undefined): ServiceIconComponent {
  if (iconName && BRANDED[iconName]) {
    return BRANDED[iconName];
  }
  return (iconName && ICONS[iconName]) || Server;
}

/**
 * Every name a service may declare.
 *
 * `iconFor` answers an unregistered name with the generic server glyph, which
 * is indistinguishable from a service that asked for it. Exposing the names lets
 * a test catch a typo or a renamed icon at the catalog, where it is a one-line
 * fix, rather than on the canvas where it looks like a design decision.
 */
export function registeredIconNames(): string[] {
  return [...Object.keys(ICONS), ...Object.keys(BRANDED)];
}
