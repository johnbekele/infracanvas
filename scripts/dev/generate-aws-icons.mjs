#!/usr/bin/env node
/**
 * Turn AWS Architecture Icons SVGs into React components.
 *
 * The marks are redrawn quarterly and there are twenty-two of them here, so
 * hand-copying path data would make the next refresh a day of transcription and
 * a diff nobody can review. This reads the unzipped asset package and writes one
 * component per icon, which makes a refresh `node scripts/dev/generate-aws-icons.mjs`.
 *
 *   curl -LO <asset package url from https://aws.amazon.com/architecture/icons/>
 *   unzip -q Icon-package_07312026.*.zip -d /tmp/aws-icons
 *   node scripts/dev/generate-aws-icons.mjs /tmp/aws-icons
 *
 * Run `pnpm format` afterwards; the emitter does not pretty-print.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(REPO, 'apps/web/src/components/designer/icons/aws');

const ARCH = 'Architecture-Service-Icons_07312026/Arch_Analytics/64';
const RES = 'Resource-Icons_07312026/Res_Analytics';
const CATEGORY = 'Category-Icons_07312026/Arch-Category_64';

/**
 * The Analytics marks, keyed by the name a catalog entry puts in its `icon`
 * field. Keys mirror service ids where a service exists, so that the catalog
 * and the icon set can be read against each other.
 *
 * QuickSight, Data Pipeline and Glue Elastic Views are absent: AWS dropped all
 * three from the package, the last because the service itself was discontinued.
 */
const ICONS = [
  ['analytics-category', 'AnalyticsCategoryIcon', `${CATEGORY}/Arch-Category_Analytics_64.svg`],
  ['athena', 'AmazonAthenaIcon', `${ARCH}/Arch_Amazon-Athena_64.svg`],
  ['cloudsearch', 'AmazonCloudSearchIcon', `${ARCH}/Arch_Amazon-CloudSearch_64.svg`],
  ['data-exchange', 'AwsDataExchangeIcon', `${ARCH}/Arch_AWS-Data-Exchange_64.svg`],
  ['emr', 'AmazonEmrIcon', `${ARCH}/Arch_Amazon-EMR_64.svg`],
  ['finspace', 'AmazonFinSpaceIcon', `${ARCH}/Arch_Amazon-FinSpace_64.svg`],
  ['firehose', 'AmazonDataFirehoseIcon', `${ARCH}/Arch_Amazon-Data-Firehose_64.svg`],
  ['glue', 'AwsGlueIcon', `${ARCH}/Arch_AWS-Glue_64.svg`],
  ['glue-databrew', 'AwsGlueDataBrewIcon', `${ARCH}/Arch_AWS-Glue-DataBrew_64.svg`],
  ['kinesis', 'AmazonKinesisDataStreamsIcon', `${ARCH}/Arch_Amazon-Kinesis-Data-Streams_64.svg`],
  ['kinesis-family', 'AmazonKinesisIcon', `${ARCH}/Arch_Amazon-Kinesis_64.svg`],
  [
    'kinesis-video-streams',
    'AmazonKinesisVideoStreamsIcon',
    `${ARCH}/Arch_Amazon-Kinesis-Video-Streams_64.svg`,
  ],
  ['lake-formation', 'AwsLakeFormationIcon', `${ARCH}/Arch_AWS-Lake-Formation_64.svg`],
  [
    'managed-flink',
    'AmazonManagedServiceForApacheFlinkIcon',
    `${ARCH}/Arch_Amazon-Managed-Service-for-Apache-Flink_64.svg`,
  ],
  ['msk', 'AmazonMskIcon', `${ARCH}/Arch_Amazon-Managed-Streaming-for-Apache-Kafka_64.svg`],
  ['opensearch', 'AmazonOpenSearchServiceIcon', `${ARCH}/Arch_Amazon-OpenSearch-Service_64.svg`],
  ['redshift', 'AmazonRedshiftIcon', `${ARCH}/Arch_Amazon-Redshift_64.svg`],

  // Resource icons: line art in the category colour, no background tile.
  [
    'cloudsearch-documents',
    'AmazonCloudSearchDocumentsIcon',
    `${RES}/Res_Amazon-CloudSearch_Search-Documents_48.svg`,
  ],
  [
    'data-exchange-apis',
    'AwsDataExchangeForApisIcon',
    `${RES}/Res_AWS-Data-Exchange-for-APIs_48.svg`,
  ],
  ['emr-cluster', 'AmazonEmrClusterIcon', `${RES}/Res_Amazon-EMR_Cluster_48.svg`],
  ['emr-engine', 'AmazonEmrEngineIcon', `${RES}/Res_Amazon-EMR_EMR-Engine_48.svg`],
  ['glue-crawler', 'AwsGlueCrawlerIcon', `${RES}/Res_AWS-Glue_Crawler_48.svg`],
];

/** SVG attributes React spells differently. Anything else hyphenated is dropped. */
const CAMEL_CASED = [
  'clip-path',
  'clip-rule',
  'fill-opacity',
  'fill-rule',
  'stop-color',
  'stop-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
];

function camel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Sketch stamps a human-readable `id` on every layer it exports, and the same
 * names recur across files -- twenty of these icons contain `id="Rectangle"`.
 * Inlined into one document those ids collide. Where nothing points at them they
 * are dead weight and get stripped; where a gradient or clip path is referenced
 * by `url(#...)` they are prefixed with the icon key instead, because dropping
 * them would break the reference and silently render the shape unfilled.
 */
function resolveIds(markup, key) {
  const referenced = /url\(#|(?:xlink:)?href="#/.test(markup);
  if (!referenced) return markup.replace(/\s+id="[^"]*"/g, '');

  return markup
    .replace(/\bid="([^"]*)"/g, (_, id) => `id="${key}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${key}-${id})`)
    .replace(/((?:xlink:)?href)="#([^"]+)"/g, (_, attribute, id) => `${attribute}="#${key}-${id}"`);
}

function toJsx(markup) {
  return markup.replace(/\s([a-z]+(?:-[a-z]+)+)=/g, (whole, name) =>
    CAMEL_CASED.includes(name) ? ` ${camel(name)}=` : whole
  );
}

/** The body of the `<svg>`, and the `viewBox` the paths are drawn against. */
function parse(svg, key) {
  const open = /<svg\b([^>]*)>/.exec(svg);
  if (!open) throw new Error('no <svg> element');

  const viewBox = /viewBox="([^"]+)"/.exec(open[1])?.[1];
  if (!viewBox) throw new Error('no viewBox; the icon could not be scaled');

  const body = svg
    .slice(open.index + open[0].length, svg.lastIndexOf('</svg>'))
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<desc>[\s\S]*?<\/desc>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  return { viewBox, body: toJsx(resolveIds(body, key)) };
}

function component(name, source, viewBox, body) {
  return `import type { SVGProps } from 'react';

/** ${source
    .split('/')
    .pop()
    .replace(/\.svg$/, '')}, from the AWS Architecture Icons package. */
export function ${name}(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" aria-hidden {...props}>
      ${body}
    </svg>
  );
}
`;
}

function main() {
  const packRoot = process.argv[2];
  if (!packRoot) {
    console.error('Usage: generate-aws-icons.mjs <unzipped-asset-package-dir>');
    return 1;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  for (const [key, name, source] of ICONS) {
    let svg;
    try {
      svg = readFileSync(join(packRoot, source), 'utf8');
    } catch {
      console.error(`::error::${source} is not in the package. Has AWS renamed or retired it?`);
      return 1;
    }

    const { viewBox, body } = parse(svg, key);
    writeFileSync(join(OUT_DIR, `${name}.tsx`), component(name, source, viewBox, body));
    console.log(`  ${name}.tsx  <- ${source}`);
  }

  const barrel = ICONS.map(([, name]) => `export { ${name} } from './${name}';`).join('\n');
  writeFileSync(join(OUT_DIR, 'index.ts'), `${barrel}\n`);

  console.log(`\n${ICONS.length} icons written to ${OUT_DIR}. Run \`pnpm format\`.`);
  return 0;
}

process.exit(main());
