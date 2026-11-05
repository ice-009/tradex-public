// Minimal typings for the official (untyped) Fyers v3 SDK. We only use the
// data socket. See node_modules/fyers-api-v3/sample/datasocket.js for usage.
declare module "fyers-api-v3" {
  export interface FyersDataSocketInstance {
    readonly FullMode: unknown;
    readonly LiteMode: unknown;
    on(event: "connect" | "message" | "error" | "close", cb: (payload: unknown) => void): void;
    subscribe(symbols: string[]): void;
    unsubscribe(symbols: string[]): void;
    mode(mode: unknown): void;
    connect(): void;
    autoreconnect(retry?: number): void;
    isConnected(): boolean;
    close(): void;
  }

  export const fyersDataSocket: {
    // (accessToken as "APPID:token", logPath, liteMode)
    getInstance(accessToken: string, logPath?: string, liteMode?: boolean): FyersDataSocketInstance;
  };
}
