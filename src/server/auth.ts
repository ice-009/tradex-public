import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/server/db/prisma";

type SessionSubscription = {
  status: string;
  plan: string;
  currentPeriodEnd?: string | Date;
  cancelAtPeriodEnd?: boolean;
} | null;

type AuthToken = {
  sub?: string;
  subscription?: SessionSubscription;
};

type AuthUser = {
  subscription?: SessionSubscription;
};

type AuthSession = {
  user?: {
    id?: string;
    subscription?: SessionSubscription;
  };
};

export const authOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          include: { subscription: true },
        });

        if (!user || !user.password) {
          return null;
        }

        const isPasswordValid = await bcrypt.compare(credentials.password, user.password);
        if (!isPasswordValid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          subscription: user.subscription,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt" as const,
  },
  callbacks: {
    async jwt({ token, user }: { token: AuthToken; user?: AuthUser | null }) {
      if (user) {
        token.subscription = user.subscription ?? null;
      }
      return token;
    },
    async session({ session, token }: { session: AuthSession; token: AuthToken }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.subscription = token.subscription ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
};
