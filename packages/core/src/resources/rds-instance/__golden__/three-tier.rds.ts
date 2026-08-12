import * as aws from "@pulumi/aws";

const rdsPrimarySubnets = new aws.rds.SubnetGroup("rdsPrimarySubnets", {
  subnetIds: [subnetPrivateA.id],
});

const rdsPrimary = new aws.rds.Instance("rdsPrimary", {
  engine: "postgres",
  engineVersion: "16.4",
  instanceClass: "db.t3.micro",
  allocatedStorage: 20,
  storageType: "gp3",
  multiAz: false,
  publiclyAccessible: false,
  deletionProtection: false,
  backupRetentionPeriod: 7,
  storageEncrypted: true,
  dbSubnetGroupName: rdsPrimarySubnets.name,
});

export const rdsPrimaryEndpoint = rdsPrimary.endpoint;
