"use client";

import * as React from "react";
import type { AuthUser } from "@/lib/auth/types";

const UserContext = React.createContext<AuthUser | null>(null);

export function UserProvider({
  user,
  children,
}: {
  user: AuthUser;
  children: React.ReactNode;
}) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useUser(): AuthUser {
  const user = React.useContext(UserContext);
  if (!user) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return user;
}

export function useHasPermission(perm: string): boolean {
  return useUser().permissions.includes(perm);
}
