import { Db } from "mongodb";
import { ObjectId, isObjectIdHex, userFilterFrom } from "./db.js";

/**
 * Read-only query layer over the Reel Estate backend collections.
 *
 * Every function here issues find/aggregate/count only — never a write. The
 * MCP layer (index.ts) just serializes these results. Keeping them as plain
 * functions means the smoke test can call them without an MCP transport.
 *
 * Collection map (Mongoose pluralizes model names):
 *   User    -> users
 *   Project -> projects
 *   Clip    -> clips
 */

function clampLimit(limit: number | undefined, fallback = 20): number {
  const ceiling = Number(process.env.MCP_MAX_LIMIT ?? 100) || 100;
  const n = Number.isFinite(limit) && limit! > 0 ? Math.floor(limit!) : fallback;
  return Math.min(n, ceiling);
}

/** Resolve a user reference (ObjectId hex or email) to its ObjectId, or throw. */
async function resolveUserId(db: Db, userRef: string): Promise<ObjectId> {
  const user = await db
    .collection("users")
    .findOne(userFilterFrom(userRef), { projection: { _id: 1 } });
  if (!user) throw new Error(`No user found for "${userRef}" (tried id and email).`);
  return user._id as ObjectId;
}

export async function findUser(db: Db, args: { user: string }) {
  const user = await db.collection("users").findOne(userFilterFrom(args.user), {
    projection: {
      password: 0, // never surface the legacy Argon2 hash
    },
  });
  if (!user) return { found: false, query: args.user };

  return {
    found: true,
    _id: String(user._id),
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    companyName: user.companyName ?? null,
    role: user.role,
    clerkId: user.clerkId ?? null,
    tenantId: user.tenantId ? String(user.tenantId) : null,
    subscription: user.subscription ?? null,
    usage: user.usage ?? null,
    isEmailVerified: user.isEmailVerified ?? null,
    deletedAt: user.deletedAt ?? null,
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.metadata?.lastLoginAt ?? null,
    lastActiveAt: user.metadata?.lastActiveAt ?? null,
  };
}

export async function listProjects(
  db: Db,
  args: { user: string; status?: string; limit?: number; skip?: number; includeDeleted?: boolean },
) {
  const userId = await resolveUserId(db, args.user);
  const match: Record<string, unknown> = { userId };
  if (!args.includeDeleted) match.deletedAt = null;
  if (args.status) match.status = args.status;

  const limit = clampLimit(args.limit, 20);
  const skip = Math.max(0, Math.floor(args.skip ?? 0));

  const total = await db.collection("projects").countDocuments(match);
  const projects = await db
    .collection("projects")
    .aggregate([
      { $match: match },
      { $sort: { lastInteractedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          name: 1,
          status: 1,
          address: "$address.formatted",
          listingStatus: "$listingFacts.status",
          imageCount: { $size: { $ifNull: ["$images", []] } },
          clipCount: { $size: { $ifNull: ["$clips", []] } },
          voiceoverCount: { $size: { $ifNull: ["$voiceovers", []] } },
          hasVoiceover: { $cond: [{ $ifNull: ["$voiceover.url", false] }, true, false] },
          hasFinalVideo: { $cond: [{ $ifNull: ["$finalVideo.url", false] }, true, false] },
          creditsUsed: "$metadata.totalCreditsUsed",
          isStarred: 1,
          lastInteractedAt: 1,
          createdAt: 1,
        },
      },
    ])
    .toArray();

  return {
    userId: String(userId),
    total,
    returned: projects.length,
    skip,
    limit,
    projects: projects.map((p) => ({ ...p, _id: String(p._id) })),
  };
}

export async function getProject(
  db: Db,
  args: { projectId: string; includeTimeline?: boolean; includeImages?: boolean },
) {
  if (!isObjectIdHex(args.projectId)) {
    throw new Error(`projectId must be a 24-char ObjectId hex string, got "${args.projectId}".`);
  }
  const projection: Record<string, 0> = {};
  // The timeline and images arrays can each be large (full editor state and
  // per-image vision analysis). Excluded by default; opt in explicitly.
  if (!args.includeTimeline) projection.timeline = 0;
  if (!args.includeImages) projection.images = 0;

  const project = await db
    .collection("projects")
    .findOne({ _id: new ObjectId(args.projectId) }, {
      projection: Object.keys(projection).length ? projection : undefined,
    });
  if (!project) return { found: false, projectId: args.projectId };

  return {
    found: true,
    ...project,
    _id: String(project._id),
    userId: project.userId ? String(project.userId) : null,
    tenantId: project.tenantId ? String(project.tenantId) : null,
    _note: {
      timelineIncluded: !!args.includeTimeline,
      imagesIncluded: !!args.includeImages,
      hint: "Pass includeTimeline:true or includeImages:true to fetch those heavy arrays.",
    },
  };
}

export async function listClips(
  db: Db,
  args: { user?: string; projectId?: string; status?: string; limit?: number; skip?: number },
) {
  const match: Record<string, unknown> = {};
  if (args.user) match.userId = await resolveUserId(db, args.user);
  if (args.projectId) {
    if (!isObjectIdHex(args.projectId)) {
      throw new Error(`projectId must be a 24-char ObjectId hex string, got "${args.projectId}".`);
    }
    match.projectId = new ObjectId(args.projectId);
  }
  if (args.status) match["processingDetails.status"] = args.status;
  if (!args.user && !args.projectId) {
    throw new Error("Provide at least one of `user` or `projectId` to scope the clip query.");
  }

  const limit = clampLimit(args.limit, 20);
  const skip = Math.max(0, Math.floor(args.skip ?? 0));

  const total = await db.collection("clips").countDocuments(match);
  const clips = await db
    .collection("clips")
    .aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          projectId: 1,
          imageId: 1,
          status: "$processingDetails.status",
          motion: "$settings.motion",
          resolution: "$settings.resolution",
          duration: "$generatedVideo.duration",
          provider: "$aiProvider.service",
          modelId: "$aiProvider.modelId",
          taskId: "$aiProvider.taskId",
          creditsUsed: "$metadata.creditsUsed",
          error: "$processingDetails.error",
          createdAt: 1,
        },
      },
    ])
    .toArray();

  return {
    scope: { user: args.user ?? null, projectId: args.projectId ?? null, status: args.status ?? null },
    total,
    returned: clips.length,
    skip,
    limit,
    clips: clips.map((c) => ({
      ...c,
      _id: String(c._id),
      projectId: c.projectId ? String(c.projectId) : null,
    })),
  };
}

export async function getUsageSummary(db: Db, args: { user: string }) {
  const userId = await resolveUserId(db, args.user);
  const user = await db
    .collection("users")
    .findOne({ _id: userId }, { projection: { usage: 1, subscription: 1, email: 1 } });

  const projectStatuses = await db
    .collection("projects")
    .aggregate([
      { $match: { userId, deletedAt: null } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          creditsUsed: { $sum: { $ifNull: ["$metadata.totalCreditsUsed", 0] } },
        },
      },
    ])
    .toArray();

  const clipStatuses = await db
    .collection("clips")
    .aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: "$processingDetails.status",
          count: { $sum: 1 },
          creditsUsed: { $sum: { $ifNull: ["$metadata.creditsUsed", 0] } },
        },
      },
    ])
    .toArray();

  const asMap = (rows: Array<{ _id: string; count: number; creditsUsed: number }>) =>
    rows.reduce<Record<string, { count: number; creditsUsed: number }>>((acc, r) => {
      acc[r._id ?? "unknown"] = { count: r.count, creditsUsed: r.creditsUsed };
      return acc;
    }, {});

  const totalProjects = projectStatuses.reduce((s, r) => s + (r as any).count, 0);
  const totalClips = clipStatuses.reduce((s, r) => s + (r as any).count, 0);

  return {
    userId: String(userId),
    email: user?.email ?? null,
    subscription: user?.subscription ?? null,
    accountUsage: user?.usage ?? null,
    projects: { total: totalProjects, byStatus: asMap(projectStatuses as any) },
    clips: { total: totalClips, byStatus: asMap(clipStatuses as any) },
  };
}

const OVERVIEW_COLLECTIONS = [
  "users",
  "tenants",
  "projects",
  "clips",
  "movies",
  "videos",
  "voiceprofiles",
  "folders",
] as const;

export async function dbOverview(db: Db) {
  const counts: Record<string, number> = {};
  await Promise.all(
    OVERVIEW_COLLECTIONS.map(async (name) => {
      try {
        counts[name] = await db.collection(name).estimatedDocumentCount();
      } catch {
        counts[name] = -1; // collection missing / not accessible
      }
    }),
  );
  return { database: db.databaseName, counts };
}
