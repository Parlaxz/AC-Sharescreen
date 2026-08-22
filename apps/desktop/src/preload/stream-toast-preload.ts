import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("toastAction", (action: "join" | "dismiss", payload: {
  groupId: string;
  hostDeviceId: string;
  logicalStreamId: string;
  hostName: string;
  groupName: string;
}) => {
  ipcRenderer.send("stream-toast:action", { action, payload });
});
