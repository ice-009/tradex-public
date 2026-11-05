type AppSubscription = {
  status: string;
  plan: string;
  currentPeriodEnd?: string | Date;
  cancelAtPeriodEnd?: boolean;
} | null;

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      subscription?: AppSubscription;
    };
  }

  interface User {
    subscription?: AppSubscription;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    subscription?: AppSubscription;
  }
}
