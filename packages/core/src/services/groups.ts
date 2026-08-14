/**
 * The AWS architecture groups: boxes drawn around other nodes.
 *
 * Most of these provision nothing. An account, a region or a corporate data
 * centre is a boundary the reader of a diagram needs in order to understand what
 * is inside what, and Terraform has no opinion about any of them -- so they
 * carry an empty `iac` and code generation skips them, the way it already skips
 * an availability zone. The ones that do provision something (`security-group`,
 * `step-functions`) live with their own services and are only marked as
 * containers there, so their emitted code is untouched.
 *
 * Stroke colours are the AWS Architecture Icons group palette, not a choice made
 * here: a dashed blue edge means region or zone to anyone who reads these
 * diagrams, and picking a nicer blue would cost that reader the recognition.
 */
import type { AWSService } from '../aws-services';
import { text } from './props';

/** AWS group palette. */
const SQUID_INK = '#242F3E';
const REGION_BLUE = '#147EBA';
const NETWORK_GREEN = '#248814';
const COMPUTE_ORANGE = '#D86613';
const ON_PREM_SLATE = '#5A6C86';
const ACCOUNT_PINK = '#E7157B';

/** A group that only organises: no resource, so nothing to emit. */
const noIac = { terraformResource: '', pulumiClass: '' } as const;

export const groupServices: AWSService[] = [
  // --- Outermost boundaries ---------------------------------------------------
  {
    id: 'aws-cloud',
    name: 'AWS Cloud',
    shortName: 'Cloud',
    category: 'grouping',
    description: 'Everything inside is running in AWS',
    color: SQUID_INK,
    icon: 'cloud',
    allowedConnections: [],
    isContainer: true,
    // The outermost box. No `allowedParents`, so it sits only on open canvas.
    group: { stroke: SQUID_INK, border: 'solid', showIcon: true },
    properties: [text('label', 'Label', 'AWS Cloud')],
    iac: noIac,
  },
  {
    id: 'corporate-data-center',
    name: 'Corporate Data Center',
    shortName: 'On-prem',
    category: 'grouping',
    description: 'Hardware you run yourself, outside AWS',
    color: ON_PREM_SLATE,
    icon: 'warehouse',
    allowedConnections: [],
    isContainer: true,
    // Deliberately not placeable inside AWS Cloud: that is the whole point of it.
    group: { stroke: ON_PREM_SLATE, border: 'solid', showIcon: true },
    properties: [text('label', 'Label', 'Corporate data center')],
    iac: noIac,
  },
  {
    id: 'region',
    name: 'Region',
    shortName: 'Region',
    category: 'grouping',
    description: 'A geographic region holding zones and networks',
    color: REGION_BLUE,
    icon: 'map',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['aws-cloud'],
    group: { stroke: REGION_BLUE, border: 'dashed', showIcon: true },
    // The label a reader sees on the box, which they then edit. It configures no
    // client and reaches no provider, so it is not a region read from code.
    properties: [text('regionName', 'Region', 'us-east-1', true)], // infracanvas-allow: no-hardcoded-region
    iac: noIac,
  },
  {
    id: 'aws-account',
    name: 'AWS Account',
    shortName: 'Account',
    category: 'grouping',
    description: 'Billing and isolation boundary around its resources',
    color: ACCOUNT_PINK,
    icon: 'building-2',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['aws-cloud'],
    group: { stroke: ACCOUNT_PINK, border: 'solid', showIcon: true },
    properties: [text('accountName', 'Account', 'production', true)],
    iac: noIac,
  },

  // --- Compute groupings ------------------------------------------------------
  {
    id: 'auto-scaling-group',
    name: 'Auto Scaling Group',
    shortName: 'ASG',
    category: 'compute',
    description: 'Capacity that grows and shrinks with demand',
    color: COMPUTE_ORANGE,
    icon: 'scaling',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['private-subnet', 'public-subnet', 'vpc-environment'],
    group: { stroke: COMPUTE_ORANGE, border: 'dashed', showIcon: true },
    properties: [
      text('groupName', 'Group Name', 'my-asg', true),
      text('minSize', 'Minimum Instances', '1'),
      text('maxSize', 'Maximum Instances', '4'),
    ],
    iac: noIac,
  },
  {
    id: 'spot-fleet',
    name: 'Spot Fleet',
    shortName: 'Spot',
    category: 'compute',
    description: 'Interruptible capacity bid for across instance types',
    color: COMPUTE_ORANGE,
    icon: 'ship',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['private-subnet', 'public-subnet', 'vpc-environment'],
    group: { stroke: COMPUTE_ORANGE, border: 'solid', showIcon: true },
    properties: [text('fleetName', 'Fleet Name', 'my-fleet', true)],
    iac: noIac,
  },
  {
    id: 'elastic-beanstalk-container',
    name: 'Elastic Beanstalk',
    shortName: 'Beanstalk',
    category: 'compute',
    description: 'Managed application environment holding its resources',
    color: COMPUTE_ORANGE,
    icon: 'sprout',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['vpc-environment', 'private-subnet', 'public-subnet'],
    group: { stroke: COMPUTE_ORANGE, border: 'solid', showIcon: true },
    properties: [text('environmentName', 'Environment', 'my-env', true)],
    iac: noIac,
  },
  {
    id: 'server-contents',
    name: 'Server Contents',
    shortName: 'Server',
    category: 'compute',
    description: 'What runs on one server',
    color: ON_PREM_SLATE,
    icon: 'server-cog',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['private-subnet', 'public-subnet'],
    group: { stroke: ON_PREM_SLATE, border: 'solid', showIcon: true },
    properties: [text('label', 'Label', 'Server')],
    iac: noIac,
  },
  {
    id: 'ec2-instance-contents',
    name: 'EC2 Instance Contents',
    shortName: 'Instance',
    category: 'compute',
    description: 'What runs inside one EC2 instance',
    color: COMPUTE_ORANGE,
    icon: 'monitor-dot',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['private-subnet', 'public-subnet'],
    group: { stroke: COMPUTE_ORANGE, border: 'solid', showIcon: true },
    properties: [text('label', 'Label', 'EC2 instance')],
    iac: noIac,
  },

  // --- Edge -------------------------------------------------------------------
  {
    id: 'iot-greengrass',
    name: 'IoT Greengrass',
    shortName: 'Greengrass',
    category: 'integration',
    description: 'Edge device running AWS code outside the cloud',
    color: NETWORK_GREEN,
    icon: 'leaf',
    allowedConnections: [],
    isContainer: true,
    // Greengrass runs on hardware you own, so it belongs outside AWS Cloud.
    group: { stroke: NETWORK_GREEN, border: 'solid', showIcon: true },
    properties: [text('label', 'Label', 'Greengrass core')],
    iac: noIac,
  },
  {
    id: 'iot-greengrass-deployment',
    name: 'IoT Greengrass Deployment',
    shortName: 'Deployment',
    category: 'integration',
    description: 'Components shipped together to edge devices',
    color: NETWORK_GREEN,
    icon: 'radio-tower',
    allowedConnections: [],
    isContainer: true,
    allowedParents: ['aws-cloud', 'region', 'aws-account'],
    group: { stroke: NETWORK_GREEN, border: 'solid', showIcon: true },
    properties: [text('deploymentName', 'Deployment', 'my-deployment', true)],
    iac: noIac,
  },
];
