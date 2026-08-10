/**
 * What a dependency implies about the infrastructure a repository needs.
 *
 * A lookup table rather than a model. The mapping from `pg` to "this needs
 * Postgres" is a fact, not a judgement, and a table can be read, reviewed, and
 * corrected by anyone who disagrees with an entry. Where the mapping genuinely
 * is a judgement -- an ORM that supports several engines -- the entry records
 * the category and leaves the capability null rather than picking one.
 */
import type { Capability, DependencyCategory, Ecosystem } from '@infracanvas/core';

export interface Signature {
  category: DependencyCategory;
  capability: Capability | null;
}

type SignatureTable = Record<string, Signature>;

const webFramework = (capability: Capability = 'http-server'): Signature => ({
  category: 'web-framework',
  capability,
});
const datastore = (capability: Capability): Signature => ({ category: 'datastore', capability });
const cache = (capability: Capability): Signature => ({ category: 'cache', capability });
const queue = (capability: Capability): Signature => ({ category: 'queue', capability });
const search = (capability: Capability): Signature => ({ category: 'search', capability });
const frontend: Signature = { category: 'frontend-framework', capability: 'frontend' };
/** Recognised, but the engine it talks to is a configuration choice, not a dependency. */
const ormOnly: Signature = { category: 'orm', capability: null };
const ml: Signature = { category: 'ml', capability: 'ml-inference' };

const NPM: SignatureTable = {
  express: webFramework(),
  fastify: webFramework(),
  koa: webFramework(),
  '@hapi/hapi': webFramework(),
  '@nestjs/core': webFramework(),
  hono: webFramework(),
  next: frontend,
  react: frontend,
  vue: frontend,
  svelte: frontend,
  '@angular/core': frontend,
  'react-dom': frontend,
  graphql: { category: 'web-framework', capability: 'graphql' },
  '@apollo/server': { category: 'web-framework', capability: 'graphql' },
  '@grpc/grpc-js': { category: 'web-framework', capability: 'grpc' },
  'socket.io': { category: 'web-framework', capability: 'websocket' },
  ws: { category: 'web-framework', capability: 'websocket' },
  pg: datastore('postgres'),
  postgres: datastore('postgres'),
  'pg-promise': datastore('postgres'),
  mysql: datastore('mysql'),
  mysql2: datastore('mysql'),
  mongodb: datastore('mongodb'),
  mongoose: datastore('mongodb'),
  redis: cache('redis'),
  ioredis: cache('redis'),
  kafkajs: queue('kafka'),
  amqplib: queue('rabbitmq'),
  '@elastic/elasticsearch': search('elasticsearch'),
  bullmq: { category: 'queue', capability: 'background-jobs' },
  bull: { category: 'queue', capability: 'background-jobs' },
  agenda: { category: 'queue', capability: 'background-jobs' },
  '@aws-sdk/client-s3': { category: 'cloud-sdk', capability: 'object-storage' },
  nodemailer: { category: 'other', capability: 'email' },
  // Support several engines, so the engine comes from their own configuration.
  prisma: ormOnly,
  '@prisma/client': ormOnly,
  typeorm: ormOnly,
  sequelize: ormOnly,
  knex: ormOnly,
  'drizzle-orm': ormOnly,
};

const PYPI: SignatureTable = {
  fastapi: webFramework(),
  flask: webFramework(),
  django: webFramework(),
  starlette: webFramework(),
  tornado: webFramework(),
  bottle: webFramework(),
  strawberry: { category: 'web-framework', capability: 'graphql' },
  grpcio: { category: 'web-framework', capability: 'grpc' },
  psycopg2: datastore('postgres'),
  'psycopg2-binary': datastore('postgres'),
  psycopg: datastore('postgres'),
  asyncpg: datastore('postgres'),
  pymysql: datastore('mysql'),
  mysqlclient: datastore('mysql'),
  pymongo: datastore('mongodb'),
  motor: datastore('mongodb'),
  redis: cache('redis'),
  celery: { category: 'queue', capability: 'background-jobs' },
  'kafka-python': queue('kafka'),
  aiokafka: queue('kafka'),
  'confluent-kafka': queue('kafka'),
  pika: queue('rabbitmq'),
  elasticsearch: search('elasticsearch'),
  boto3: { category: 'cloud-sdk', capability: null },
  torch: ml,
  tensorflow: ml,
  transformers: ml,
  'scikit-learn': ml,
  onnxruntime: ml,
  sqlalchemy: ormOnly,
  alembic: ormOnly,
};

const GO: SignatureTable = {
  'github.com/gin-gonic/gin': webFramework(),
  'github.com/labstack/echo': webFramework(),
  'github.com/gofiber/fiber': webFramework(),
  'github.com/gorilla/mux': webFramework(),
  'github.com/go-chi/chi': webFramework(),
  'google.golang.org/grpc': { category: 'web-framework', capability: 'grpc' },
  'github.com/lib/pq': datastore('postgres'),
  'github.com/jackc/pgx': datastore('postgres'),
  'github.com/go-sql-driver/mysql': datastore('mysql'),
  'go.mongodb.org/mongo-driver': datastore('mongodb'),
  'github.com/redis/go-redis': cache('redis'),
  'github.com/go-redis/redis': cache('redis'),
  'github.com/segmentio/kafka-go': queue('kafka'),
  'github.com/rabbitmq/amqp091-go': queue('rabbitmq'),
  'github.com/elastic/go-elasticsearch': search('elasticsearch'),
  'github.com/aws/aws-sdk-go-v2': { category: 'cloud-sdk', capability: null },
  'gorm.io/gorm': ormOnly,
};

const CARGO: SignatureTable = {
  axum: webFramework(),
  'actix-web': webFramework(),
  rocket: webFramework(),
  warp: webFramework(),
  tonic: { category: 'web-framework', capability: 'grpc' },
  'tokio-postgres': datastore('postgres'),
  postgres: datastore('postgres'),
  mysql: datastore('mysql'),
  mongodb: datastore('mongodb'),
  redis: cache('redis'),
  rdkafka: queue('kafka'),
  lapin: queue('rabbitmq'),
  elasticsearch: search('elasticsearch'),
  'aws-sdk-s3': { category: 'cloud-sdk', capability: 'object-storage' },
  sqlx: ormOnly,
  diesel: ormOnly,
  'sea-orm': ormOnly,
};

const MAVEN: SignatureTable = {
  'spring-boot-starter-web': webFramework(),
  'spring-boot-starter-webflux': webFramework(),
  'spring-boot-starter-data-jpa': ormOnly,
  postgresql: datastore('postgres'),
  'mysql-connector-java': datastore('mysql'),
  'mongodb-driver-sync': datastore('mongodb'),
  jedis: cache('redis'),
  'lettuce-core': cache('redis'),
  'kafka-clients': queue('kafka'),
  'amqp-client': queue('rabbitmq'),
};

const RUBYGEMS: SignatureTable = {
  rails: webFramework(),
  sinatra: webFramework(),
  puma: webFramework(),
  pg: datastore('postgres'),
  mysql2: datastore('mysql'),
  mongoid: datastore('mongodb'),
  'redis-rb': cache('redis'),
  redis: cache('redis'),
  sidekiq: { category: 'queue', capability: 'background-jobs' },
  'aws-sdk-s3': { category: 'cloud-sdk', capability: 'object-storage' },
};

const COMPOSER: SignatureTable = {
  'laravel/framework': webFramework(),
  'symfony/framework-bundle': webFramework(),
  'slim/slim': webFramework(),
  'doctrine/orm': ormOnly,
  'predis/predis': cache('redis'),
  'mongodb/mongodb': datastore('mongodb'),
  'elasticsearch/elasticsearch': search('elasticsearch'),
};

const TABLES: Record<Ecosystem, SignatureTable> = {
  npm: NPM,
  pypi: PYPI,
  go: GO,
  cargo: CARGO,
  maven: MAVEN,
  rubygems: RUBYGEMS,
  composer: COMPOSER,
};

/**
 * Look up a dependency, returning null when it is not one this table knows.
 *
 * Go module paths are matched by prefix because they carry a major version
 * suffix (`/v5`) and often a submodule path, neither of which changes what the
 * dependency implies. Everything else is matched exactly, case-insensitively,
 * since package names are case-insensitive in practice across these registries.
 */
export function lookupSignature(ecosystem: Ecosystem, name: string): Signature | null {
  const table = TABLES[ecosystem];
  const normalised = name.toLowerCase();

  const exact = table[normalised];
  if (exact) return exact;

  if (ecosystem === 'go') {
    for (const [prefix, signature] of Object.entries(table)) {
      if (normalised === prefix || normalised.startsWith(`${prefix}/`)) return signature;
    }
  }

  return null;
}
