import { create } from "zustand";

export interface LocalIdentityState {
  localDeviceId: string;
  localDisplayName: string;
  setLocalIdentity: (identity: { deviceId: string; displayName: string }) => void;
}

export const useIdentityStore = create<LocalIdentityState>((set) => ({
  localDeviceId: "",
  localDisplayName: "User",
  setLocalIdentity: (identity) =>
    set({
      localDeviceId: identity.deviceId,
      localDisplayName: identity.displayName,
    }),
}));
