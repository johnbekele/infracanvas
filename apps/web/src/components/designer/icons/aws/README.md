# AWS Architecture Icons

Every component in this folder is generated. Do not edit one by hand: the next refresh
overwrites it.

## Provenance

|          |                                                                                |
| -------- | ------------------------------------------------------------------------------ |
| Package  | `Icon-package_07312026` (Q3 2026, released 31 July 2026)                       |
| Source   | <https://aws.amazon.com/architecture/icons/>                                   |
| Category | Analytics (architecture service icons, resource icons, and the category badge) |

The artwork is owned by Amazon Web Services, Inc. AWS permits its use in architecture
diagrams and related material under the terms published on the page above. It is
redistributed here unmodified in shape; the generator only rewrites the SVG markup into
JSX and strips the layer names Sketch exports.

## Refreshing

AWS publishes a new package at the end of January, April and July. To take one:

```bash
curl -LO "<asset package url from the icons page>"
unzip -q Icon-package_*.zip -d /tmp/aws-icons
node scripts/dev/generate-aws-icons.mjs /tmp/aws-icons
pnpm format
```

The dated folder names are baked into the manifest at the top of
[`scripts/dev/generate-aws-icons.mjs`](../../../../../../../scripts/dev/generate-aws-icons.mjs),
so a new package needs those constants changed. The generator fails loudly on a mark it
cannot find, which is the signal that AWS renamed or retired a service.

## Marks AWS no longer ships

Three Analytics marks that earlier packages carried are absent from this one, so no
component exists for them:

- **Amazon QuickSight** and **AWS Data Pipeline** were dropped from the Analytics set.
- **AWS Glue Elastic Views** went with the service, which AWS discontinued after preview.
