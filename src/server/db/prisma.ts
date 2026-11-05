import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const adapter = new PrismaBetterSqlite3({ url: "./dev.db" });

function createPrismaClient() {
  return new PrismaClient({
    adapter,
    log: ["warn", "error"],
  });
}

type AppPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: AppPrismaClient | undefined;
};

// Cache the client on globalThis in development so Turbopack/Next HMR reuses a
// single PrismaClient across hot reloads. Creating a fresh client per reload
// leaks a better-sqlite3 connection + query engine every time a module is
// re-evaluated, which exhausts memory. To pick up new schema models after a
// `prisma generate`, restart the dev server (the reload cache is intentional).
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
