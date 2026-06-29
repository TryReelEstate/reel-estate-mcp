import { MongoClient, Db, ObjectId } from "mongodb";

/**
 * Single lazily-initialized MongoClient shared across all tool calls.
 *
 * The MCP server is a long-lived stdio process, so we connect once on first
 * use and reuse the pool. We deliberately keep a small pool — this is an
 * inspection/support tool, not a hot path.
 */
let clientPromise: Promise<MongoClient> | null = null;

export function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and fill it in, " +
        "or pass MONGODB_URI in the MCP server's `env` config block.",
    );
  }
  return uri;
}

export async function getDb(): Promise<Db> {
  if (!clientPromise) {
    const client = new MongoClient(getMongoUri(), {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      // We never issue writes from this server, but make intent explicit:
      // a primary read preference is fine; reads won't mutate anything.
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  // db() with no name uses the database from the connection string
  // (reel-estate-v2 for staging).
  return client.db();
}

export async function closeDb(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
  }
}

/** True if the string is a 24-char hex ObjectId. */
export function isObjectIdHex(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value.trim());
}

/**
 * Resolve a user reference that may be either a 24-char ObjectId hex string
 * or an email address into a Mongo filter on the `users` collection.
 */
export function userFilterFrom(userRef: string): Record<string, unknown> {
  const v = userRef.trim();
  if (isObjectIdHex(v)) return { _id: new ObjectId(v) };
  return { email: v.toLowerCase() };
}

export { ObjectId };
